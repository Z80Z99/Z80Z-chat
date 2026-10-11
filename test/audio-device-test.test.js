import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { createAudioDeviceTest } from '../frontend/src/utils/audio-device-test.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(overrides = {}) {
  const states = [], contexts = [], audios = [], captures = [], streams = []
  const frames = new Map(), timers = new Map()
  let timerId = 0, interrupt, unbound = 0, deviceChanges = 0
  function stream(deviceId = 'microphone-a') {
    const listeners = new Set()
    const track = { stops: 0, getSettings: () => ({ deviceId }), stop() { this.stops++ }, addEventListener(type, listener) { listeners.add(listener) }, removeEventListener(type, listener) { listeners.delete(listener) }, end() { for (const listener of [...listeners]) listener() }, listeners }
    const value = { track, getTracks: () => [track], getAudioTracks: () => [track] }
    streams.push(value)
    return value
  }
  function node(type) {
    return { type, connections: [], disconnections: 0, connect(other) { this.connections.push(other) }, disconnect() { this.disconnections++ } }
  }
  function context() {
    const value = {
      state: 'running', currentTime: 0, closes: 0, nodes: [], destination: node('call-output'),
      close() { this.closes++; this.state = 'closed'; return Promise.resolve() },
      resume: () => Promise.resolve(),
      createMediaStreamSource(media) { const result = { ...node('source'), media }; this.nodes.push(result); return result },
      createGain() { const result = { ...node('gain'), gain: { value: 1, setTargetAtTime(value) { this.value = value } } }; this.nodes.push(result); return result },
      createAnalyser() { const result = { ...node('analyser'), fftSize: 512, amplitude: 32, getByteTimeDomainData(values) { values.fill(128 + this.amplitude) } }; this.nodes.push(result); return result },
      createOscillator() { const result = { ...node('oscillator'), starts: 0, stops: 0, frequency: { value: 0 }, start() { this.starts++ }, stop() { this.stops++ } }; this.nodes.push(result); return result },
      createMediaStreamDestination() { const result = { ...node('test-output'), stream: stream() }; this.nodes.push(result); return result }
    }
    contexts.push(value)
    return value
  }
  function audio() {
    const value = {
      volume: 1, srcObject: null, sink: null, plays: 0, pauses: 0, loads: 0,
      setSinkId(id) { this.sink = id; return Promise.resolve() },
      play() { this.plays++; return Promise.resolve() }, pause() { this.pauses++ },
      removeAttribute() {}, load() { this.loads++ }
    }
    audios.push(value)
    return value
  }
  const deps = {
    secureContext: () => true,
    getUserMedia: async constraints => { captures.push(constraints); return stream() },
    createContext: context, createAudio: audio,
    requestFrame(callback) { const id = ++timerId; frames.set(id, callback); return id }, cancelFrame(id) { frames.delete(id) },
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimer(id) { timers.delete(id) },
    bindInterrupt(stop) { interrupt = stop; return () => { unbound++; interrupt = undefined } },
    changed() { deviceChanges++ },
    ...overrides
  }
  const options = { inputDeviceId: 'microphone-a', outputDeviceId: 'speaker-a', inputVolume: 1, outputVolume: .5, deafened: false }
  const tester = createAudioDeviceTest(options, state => states.push(state), deps)
  return { tester, states, contexts, audios, captures, streams, frames, timers, deps, options, stream, context, audio, interrupt: () => interrupt?.(), get unbound() { return unbound }, get deviceChanges() { return deviceChanges } }
}

test('设备测试在显式开始前不采集或播放，麦克风只驱动本地电平', async () => {
  const h = harness()
  assert.equal(h.captures.length, 0)
  assert.equal(h.contexts.length, 0)
  assert.equal(h.tester.getState().status, 'idle')
  await h.tester.startMicrophone()
  assert.deepEqual(h.captures, [{ audio: { deviceId: { exact: 'microphone-a' } }, video: false }])
  const [source, gain, analyser] = h.contexts[0].nodes
  assert.deepEqual(source.connections, [gain])
  assert.deepEqual(gain.connections, [analyser])
  assert.equal(analyser.connections.length, 0, '不连接扬声器或通话的输出')
  assert.equal(h.audios.length, 0)
  assert.equal(h.tester.getState().level, .75)
  assert.equal(h.deviceChanges, 1)
  h.tester.stop()
  assert.equal(h.streams[0].track.stops, 1)
  assert.equal(h.streams[0].track.listeners.size, 0)
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(h.frames.size, 0)
  assert.equal(h.tester.getState().level, 0)
})

test('权限等待中停止或更换设备，迟到的麦克风流立即释放', async () => {
  for (const cancel of [h => h.tester.stop(), h => h.tester.update({ ...h.options, inputDeviceId: 'microphone-b' }), h => h.tester.dispose(), h => h.interrupt()]) {
    const request = deferred()
    const h = harness({ getUserMedia: () => request.promise })
    const starting = h.tester.startMicrophone()
    assert.equal(h.tester.getState().status, 'starting')
    cancel(h)
    const late = h.stream()
    request.resolve(late)
    await starting
    assert.equal(late.track.stops, 1)
    assert.equal(h.contexts.length, 0)
    assert.equal(h.tester.getState().status, 'idle')
  }
})

test('旧权限请求返回不能覆盖新设备测试或泄露流', async () => {
  const first = deferred(), second = deferred()
  let count = 0
  const h = harness({ getUserMedia: () => ++count === 1 ? first.promise : second.promise })
  const old = h.tester.startMicrophone()
  h.tester.update({ ...h.options, inputDeviceId: 'microphone-b' })
  const next = h.tester.startMicrophone()
  const newestStream = h.stream()
  second.resolve(newestStream)
  await next
  const oldStream = h.stream()
  first.resolve(oldStream)
  await old
  assert.equal(oldStream.track.stops, 1)
  assert.equal(newestStream.track.stops, 0)
  assert.equal(h.contexts.length, 1)
  assert.equal(h.tester.getState().status, 'running')
  h.tester.dispose()
})

test('初始化与授权刷新揭示默认设备身份不会取消麦克风，实际换设备仍立即释放', async () => {
  const permission = deferred()
  const h = harness({ getUserMedia: () => permission.promise })
  h.tester.update({ ...h.options, inputDeviceId: '', outputDeviceId: '' })
  const pending = h.tester.startMicrophone()
  h.tester.update({ ...h.options, inputDeviceId: 'default', outputDeviceId: 'default' })
  assert.equal(h.tester.getState().status, 'starting', '初始异步枚举把空ID补成default不是真正切换设备')
  const stream = h.stream('revealed-physical-device')
  permission.resolve(stream)
  await pending
  h.tester.update({ ...h.options, inputDeviceId: 'revealed-physical-device', outputDeviceId: 'speaker-revealed' })
  assert.equal(h.tester.getState().status, 'running', '授权后枚举揭示同一捕获设备的实际ID不终止测试')
  assert.equal(stream.track.stops, 0)
  assert.equal(h.frames.size, 1)
  h.tester.update({ ...h.options, inputDeviceId: 'other-physical-device', outputDeviceId: 'speaker-revealed' })
  assert.equal(h.tester.getState().status, 'idle')
  assert.equal(stream.track.stops, 1)
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(h.frames.size, 0)
})

test('设备刷新只影响正在测试的设备，扬声器默认ID别名变化不重启或取消', async () => {
  const h = harness()
  h.tester.update({ ...h.options, outputDeviceId: '' })
  await h.tester.startSpeaker()
  h.tester.update({ ...h.options, inputDeviceId: 'another-microphone', outputDeviceId: 'default' })
  assert.equal(h.tester.getState().status, 'running')
  assert.equal(h.audios[0].pauses, 0)
  h.tester.update({ ...h.options, inputDeviceId: 'another-microphone', outputDeviceId: 'another-speaker' })
  assert.equal(h.tester.getState().status, 'idle')
  assert.equal(h.audios[0].pauses, 1)
  assert.equal(h.timers.size, 0)
})

test('麦克风失败区分权限拒绝、设备缺失及无法访问；非安全地址不请求权限', async () => {
  for (const [name, expected] of [['NotAllowedError', /权限被拒绝/], ['NotFoundError', /未找到所选麦克风/], ['OverconstrainedError', /未找到所选麦克风/], ['NotReadableError', /占用或断开/]]) {
    const error = Object.assign(new Error('raw'), { name })
    const h = harness({ getUserMedia: async () => { throw error } })
    await h.tester.startMicrophone()
    assert.equal(h.tester.getState().status, 'error')
    assert.match(h.tester.getState().error, expected)
    assert.equal(h.contexts.length, 0)
  }
  const insecure = harness({ secureContext: () => false })
  await insecure.tester.startMicrophone()
  assert.match(insecure.tester.getState().error, /HTTPS 或本机 localhost/)
  assert.equal(insecure.captures.length, 0)
  await insecure.tester.startSpeaker()
  assert.equal(insecure.contexts.length, 0)
})

test('麦克风断开和音频上下文失败释放所有资源，并允许之后重试', async () => {
  const h = harness()
  await h.tester.startMicrophone()
  h.streams[0].track.end()
  assert.match(h.tester.getState().error, /麦克风已断开/)
  assert.equal(h.frames.size, 0)
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(h.deviceChanges, 2)
  await h.tester.startMicrophone()
  assert.equal(h.tester.getState().status, 'running')
  h.tester.dispose()
  const broken = harness({ createContext() { throw new Error('context failed') } })
  await broken.tester.startMicrophone()
  assert.equal(broken.streams[0].track.stops, 1)
  assert.match(broken.tester.getState().error, /context failed/)
})

test('扬声器使用独立的低音量测试流和选择的输出，自动停止后释放播放器', async () => {
  const h = harness()
  await h.tester.startSpeaker()
  assert.equal(h.captures.length, 0, '不会开启麦克风')
  const [oscillator, gain, destination] = h.contexts[0].nodes
  assert.deepEqual(oscillator.connections, [gain])
  assert.deepEqual(gain.connections, [destination])
  assert.equal(gain.gain.value, .03)
  assert.equal(h.audios[0].sink, 'speaker-a')
  assert.equal(h.audios[0].srcObject, destination.stream)
  assert.equal(oscillator.starts, 1)
  assert.equal(h.tester.getState().status, 'running')
  const timer = [...h.timers.values()][0]
  assert.equal(timer.delay, 1200)
  timer.callback()
  assert.equal(h.tester.getState().status, 'idle')
  assert.equal(h.timers.size, 0)
  assert.equal(h.streams[0].track.stops, 1)
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(h.audios[0].srcObject, null)
  assert.equal(h.audios[0].pauses, 1)
})

test('耳机静音禁止扬声器测试，并停止正在播放或等待输出路由的测试', async () => {
  const h = harness()
  h.tester.update({ ...h.options, deafened: true })
  await h.tester.startSpeaker()
  assert.equal(h.contexts.length, 0)
  assert.match(h.tester.getState().error, /关闭声音/)
  h.tester.update(h.options)
  await h.tester.startSpeaker()
  h.tester.update({ ...h.options, deafened: true })
  assert.equal(h.audios[0].srcObject, null)
  assert.equal(h.timers.size, 0)
  const route = deferred()
  const pending = harness({ createAudio() { const value = pending.audio(); value.setSinkId = () => route.promise; return value } })
  const start = pending.tester.startSpeaker()
  pending.tester.update({ ...pending.options, deafened: true })
  route.resolve()
  await start
  assert.equal(pending.audios[0].plays, 0)
  assert.equal(pending.contexts[0].closes, 1)
  assert.equal(pending.tester.getState().status, 'idle')
})

test('输出路由或播放拒绝明确反馈并释放媒体，不退回错误扬声器', async () => {
  for (const method of ['setSinkId', 'play']) {
    const h = harness({ createAudio() { const value = h.audio(); value[method] = async () => { throw Object.assign(new Error('blocked'), { name: method === 'setSinkId' ? 'NotFoundError' : 'NotAllowedError' }) }; return value } })
    await h.tester.startSpeaker()
    assert.equal(h.tester.getState().status, 'error')
    assert.match(h.tester.getState().error, method === 'setSinkId' ? /未找到所选扬声器/ : /阻止了测试音/)
    assert.equal(h.contexts[0].closes, 1)
    assert.equal(h.streams[0].track.stops, 1)
    assert.equal(h.audios[0].srcObject, null)
    assert.equal(h.timers.size, 0)
  }
})

test('不支持输出选择的浏览器仅允许默认设备，并保持清晰反馈', async () => {
  const h = harness({ createAudio() { const value = h.audio(); delete value.setSinkId; return value } })
  await h.tester.startSpeaker()
  assert.match(h.tester.getState().error, /浏览器不支持选择扬声器/)
  assert.equal(h.audios[0].plays, 0)
  h.tester.update({ ...h.options, outputDeviceId: '' })
  await h.tester.startSpeaker()
  assert.equal(h.tester.getState().status, 'running')
  h.tester.dispose()
})

test('测试互斥，音量实时限幅，失焦/隐藏/卸载取消活动资源', async () => {
  const h = harness()
  await h.tester.startMicrophone()
  h.tester.update({ ...h.options, inputVolume: 9 })
  assert.equal(h.contexts[0].nodes.find(node => node.type === 'gain').gain.value, 2)
  h.tester.update({ ...h.options, inputVolume: -2 })
  assert.equal(h.contexts[0].nodes.find(node => node.type === 'gain').gain.value, 0)
  await h.tester.startSpeaker()
  assert.equal(h.streams[0].track.stops, 1)
  assert.equal(h.frames.size, 0)
  h.tester.update({ ...h.options, outputVolume: Infinity })
  assert.equal(h.contexts[1].nodes.find(node => node.type === 'gain').gain.value, 0)
  h.tester.update({ ...h.options, outputVolume: 4 })
  assert.equal(h.contexts[1].nodes.find(node => node.type === 'gain').gain.value, .06)
  h.interrupt()
  assert.equal(h.contexts[1].closes, 1)
  assert.equal(h.timers.size, 0)
  await h.tester.startMicrophone()
  h.tester.dispose()
  h.tester.dispose()
  assert.equal(h.unbound, 1)
  assert.equal(h.contexts[2].closes, 1)
  await h.tester.startMicrophone()
  assert.equal(h.contexts.length, 3)
})

test('等待上下文恢复或播放时停止，迟到完成不会重新运行或挂计时器', async () => {
  for (const stage of ['resume', 'play']) {
    const pending = deferred()
    const h = harness({
      createContext() { const value = h.context(); if (stage === 'resume') value.resume = () => pending.promise; return value },
      createAudio() { const value = h.audio(); if (stage === 'play') value.play = () => pending.promise; return value }
    })
    const starting = h.tester.startSpeaker()
    await Promise.resolve(); await Promise.resolve()
    h.tester.stop()
    pending.resolve()
    await starting
    assert.equal(h.tester.getState().status, 'idle')
    assert.equal(h.contexts[0].closes, 1)
    assert.equal(h.timers.size, 0)
  }
})

test('浏览器事件绑定只在页面隐藏或失焦时停止，卸载移除监听并释放权限迟到流', async () => {
  const listeners = new Map()
  function surface() {
    return {
      addEventListener(type, listener) { listeners.set(`${this.id}:${type}`, listener) },
      removeEventListener(type, listener) { if (listeners.get(`${this.id}:${type}`) === listener) listeners.delete(`${this.id}:${type}`) }
    }
  }
  const request = deferred()
  const h = harness()
  const window = { ...surface(), id: 'window', isSecureContext: true, AudioContext: function () { return h.context() }, requestAnimationFrame: h.deps.requestFrame, cancelAnimationFrame: h.deps.cancelFrame }
  const document = { ...surface(), id: 'document', visibilityState: 'visible' }
  const module = { exports: {} }
  const source = readFileSync(new URL('../frontend/src/utils/audio-device-test.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const context = { window, document, navigator: { mediaDevices: { getUserMedia: () => request.promise } }, Audio: function () { return h.audio() }, setTimeout: h.deps.setTimer, clearTimeout: h.deps.clearTimer, exports: module.exports }
  vm.runInNewContext(code, context)
  const tester = module.exports.createAudioDeviceTest(h.options, () => {})
  const pending = tester.startMicrophone()
  listeners.get('document:visibilitychange')()
  assert.equal(tester.getState().status, 'starting', '可见页面的 visibilitychange 不取消权限请求')
  document.visibilityState = 'hidden'
  listeners.get('document:visibilitychange')()
  const late = h.stream()
  request.resolve(late)
  await pending
  assert.equal(late.track.stops, 1)
  document.visibilityState = 'visible'
  await tester.startSpeaker()
  listeners.get('window:blur')()
  assert.equal(tester.getState().status, 'idle')
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(h.timers.size, 0)
  tester.dispose()
  assert.equal(listeners.size, 0)
})

const source = readFileSync(new URL('../frontend/src/components/AudioDeviceTest.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const componentCode = ts.transpileModule(`${script}\nglobalThis.component = { tester, state, statusText, testMicrophone };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText

test('组件授权成功触发设备枚举回填后仍显示电平测试，收起卸载仍完整释放', async () => {
  const h = harness()
  const props = vue.reactive({ inputDeviceId: '', outputDeviceId: '', inputVolume: 1, outputVolume: 1, deafened: false, stopKey: 'account-a:room-a' })
  const unmount = [], state = {}, events = []
  const context = {
    require(path) {
      if (path === 'vue') return { ...vue, onUnmounted: callback => unmount.push(callback) }
      if (path === '../utils/audio-device-test') return { createAudioDeviceTest(value, changed) { return createAudioDeviceTest(value, changed, h.deps) } }
      if (path.endsWith('.css')) return {}
      throw new Error(`Unexpected require: ${path}`)
    }, exports: {}, defineProps: () => props, withDefaults: value => value,
    defineEmits: () => event => {
      events.push(event)
      props.inputDeviceId = 'microphone-a'
      props.outputDeviceId = 'revealed-speaker'
    }, defineExpose() {}, globalThis: state
  }
  const scope = vue.effectScope()
  scope.run(() => vm.runInNewContext(componentCode, context))
  await state.component.testMicrophone()
  assert.deepEqual(events, ['devices-changed'])
  assert.equal(state.component.state.value.status, 'running')
  assert.equal(h.streams[0].track.stops, 0)
  assert.equal(h.frames.size, 1)
  unmount[0]()
  scope.stop()
  assert.equal(h.streams[0].track.stops, 1)
  assert.equal(h.frames.size, 0)
})

test('设备测试组件变化设备或上下文立即停止，音量变化保留测试，卸载释放', async () => {
  const events = [], unmount = [], updates = [], state = {}
  const props = vue.reactive({ inputDeviceId: '', outputDeviceId: '', inputVolume: 1, outputVolume: 1, deafened: false, stopKey: 'account-a:room-a' })
  let stops = 0, disposes = 0, callback
  const fake = { startMicrophone: async () => { callback({ kind: 'microphone', status: 'running', level: .2, error: '' }) }, startSpeaker: async () => {}, stop() { stops++ }, dispose() { disposes++ }, update(value) { updates.push({ ...value }) } }
  const context = {
    require(path) {
      if (path === 'vue') return { ...vue, onUnmounted: callback => unmount.push(callback) }
      if (path === '../utils/audio-device-test') return { createAudioDeviceTest(value, changed) { callback = changed; return fake } }
      if (path.endsWith('.css')) return {}
      throw new Error(`Unexpected require: ${path}`)
    }, exports: {}, defineProps: () => props, withDefaults: value => value, defineEmits: () => event => events.push(event), defineExpose() {}, globalThis: state
  }
  vm.runInNewContext(componentCode, context)
  assert.equal(events.length, 0)
  await state.component.testMicrophone()
  assert.deepEqual(events, ['devices-changed'])
  props.inputVolume = .4
  assert.equal(updates.at(-1).inputVolume, .4)
  assert.equal(stops, 0)
  props.stopKey = 'account-b:room-a'
  assert.equal(stops, 1)
  props.outputDeviceId = 'new-speaker'
  assert.equal(updates.at(-1).outputDeviceId, 'new-speaker')
  props.deafened = true
  assert.equal(updates.at(-1).deafened, true)
  unmount[0]()
  assert.equal(disposes, 1)
})
