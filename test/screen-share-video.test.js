import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

const source = readFileSync(new URL('../frontend/src/components/ScreenShareVideo.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const code = ts.transpileModule(`${script}\nglobalThis.player = { videoRef, containerRef, status, paused, manualPaused, fps, framesPresented, videoResolution, isFullscreen, fullscreenError, fullscreenPending, playLabel, statusLabel, togglePlay, toggleFullscreen };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

class Surface {
  listeners = new Map()
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback) }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  dispatch(type) { for (const callback of [...this.listeners.get(type) || []]) callback({ type, target: this }) }
  listenerCount() { return [...this.listeners.values()].reduce((total, values) => total + values.size, 0) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function media() {
  const track = Object.assign(new Surface(), { readyState: 'live', muted: false, stops: 0, stop() { this.stops++ } })
  const stream = vue.markRaw(Object.assign(new Surface(), { tracks: [track], getVideoTracks() { return this.tracks }, getTracks() { return this.tracks } }))
  return { stream, track }
}
function clock() {
  let now = 100, id = 0
  const timers = new Map()
  function schedule(callback, duration, interval = 0) { const key = ++id; timers.set(key, { callback, due: now + duration, interval }); return key }
  return {
    timers, now: () => now,
    setTimeout: (callback, duration) => schedule(callback, duration), clearTimeout: key => timers.delete(key),
    setInterval: (callback, duration) => schedule(callback, duration, duration), clearInterval: key => timers.delete(key),
    advance(duration) {
      const end = now + duration
      while (true) {
        const next = [...timers].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        const [key, timer] = next
        now = timer.due
        if (timer.interval) timer.due += timer.interval
        else timers.delete(key)
        timer.callback()
      }
      now = end
    }
  }
}

function harness(t, options = {}) {
  const time = clock(), emits = [], ticks = [], mounts = [], unmounts = [], frames = new Map()
  let frameId = 0, playCalls = 0, pauses = 0, exits = 0
  const initial = media()
  const props = vue.reactive({ userId: 'remote', stream: initial.stream, active: options.active ?? true, local: !!options.local, name: '南风' })
  const video = vue.markRaw(Object.assign(new Surface(), {
    srcObject: null, paused: true, currentTime: 0, readyState: options.readyState ?? 2, videoWidth: 1280, videoHeight: 720, muted: false, error: null,
    play() { playCalls++; this.paused = false; return options.play ? options.play(this, playCalls) : Promise.resolve() },
    pause() { pauses++; this.paused = true; this.dispatch('pause') },
    requestVideoFrameCallback(callback) { const id = ++frameId; frames.set(id, callback); return id },
    cancelVideoFrameCallback(id) { frames.delete(id) },
    getVideoPlaybackQuality: undefined
  }))
  if (options.frameApi === false) { delete video.requestVideoFrameCallback; delete video.cancelVideoFrameCallback }
  if (options.quality) video.getVideoPlaybackQuality = options.quality
  const document = Object.assign(new Surface(), { visibilityState: 'visible', fullscreenElement: null,
    exitFullscreen() { exits++; if (options.exitFullscreen) return options.exitFullscreen(); this.fullscreenElement = null; this.dispatch('fullscreenchange'); return Promise.resolve() }
  })
  const container = vue.markRaw({ contains: value => value === video, requestFullscreen: async () => {
    if (options.fullscreen) return options.fullscreen(container, document)
    document.fullscreenElement = container; document.dispatch('fullscreenchange')
  } })
  const context = {
    exports: {}, document, Date: { now: time.now }, ...time,
    defineProps: () => props, withDefaults: value => value,
    defineEmits: () => (...args) => { emits.push(args); options.emit?.(...args) },
    require(name) {
      if (name === 'vue') return { ...vue, nextTick: callback => { ticks.push(callback); return Promise.resolve() }, onMounted: callback => mounts.push(callback), onUnmounted: callback => unmounts.push(callback) }
      throw new Error(`Unexpected import: ${name}`)
    }
  }
  const scope = vue.effectScope()
  scope.run(() => vm.runInNewContext(code, context))
  const player = context.player
  player.videoRef.value = video; player.containerRef.value = container
  mounts.forEach(callback => callback())
  const flush = async () => { while (ticks.length) ticks.shift()(); for (let i = 0; i < 6; i++) await Promise.resolve() }
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; unmounts.forEach(callback => callback()); scope.stop() }
  t.after(dispose)
  return { ...player, ...initial, props, video, container, document, time, emits, ticks, frames, flush, dispose,
    get playCalls() { return playCalls }, get pauses() { return pauses }, get exits() { return exits },
    frame(metadata = {}) { const next = [...frames][0]; if (!next) return; frames.delete(next[0]); next[1](time.now(), { presentedFrames: 1, width: 1280, height: 720, ...metadata }) },
    reports: () => emits.filter(([name]) => name === 'playback').map(([, value]) => value),
    refreshes: () => emits.filter(([name]) => name === 'refresh').length
  }
}

test('自动播放仅绑定当前流且保持静音，手动暂停不会被metadata/canplay/unmute恢复', async t => {
  const h = harness(t)
  await h.flush()
  assert.equal(h.video.srcObject, h.stream)
  assert.equal(h.video.muted, true)
  assert.equal(h.status.value, 'playing')
  h.togglePlay()
  assert.equal(h.status.value, 'paused')
  assert.equal(h.manualPaused.value, true)
  const plays = h.playCalls
  h.video.dispatch('loadedmetadata'); h.video.dispatch('canplay'); h.track.dispatch('unmute')
  await h.flush()
  assert.equal(h.playCalls, plays)
  assert.equal(h.video.paused, true)
  assert.equal(h.frames.size, 0)
  assert.equal(h.time.timers.size, 0)
  h.time.advance(30000)
  assert.equal(h.refreshes(), 0)
  h.togglePlay(); await h.flush()
  assert.equal(h.status.value, 'playing')
})

test('影院inactive与页面隐藏暂停渲染，恢复保留手动暂停意图，不停止共享轨道', async t => {
  const h = harness(t)
  await h.flush()
  h.props.active = false
  assert.equal(h.video.paused, true)
  assert.equal(h.frames.size, 0)
  h.time.advance(15000)
  assert.equal(h.refreshes(), 0)
  h.props.active = true; await h.flush()
  assert.equal(h.video.paused, false)
  h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange')
  assert.equal(h.video.paused, true)
  h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange'); await h.flush()
  assert.equal(h.video.paused, false)
  h.togglePlay()
  h.props.active = false; h.props.active = true
  h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange')
  h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange'); await h.flush()
  assert.equal(h.video.paused, true)
  assert.equal(h.track.stops, 0)
})

test('手动暂停期间更换流不自动恢复，旧track/media事件和nextTick不能改变新流状态', async t => {
  const h = harness(t)
  const oldTick = h.ticks[0], oldMetadata = [...h.video.listeners.get('loadedmetadata')][0], oldEnded = [...h.track.listeners.get('ended')][0]
  await h.flush(); h.togglePlay()
  const next = media()
  h.props.stream = next.stream
  oldTick(); oldMetadata(); oldEnded(); await h.flush()
  assert.equal(h.video.srcObject, next.stream)
  assert.equal(h.video.paused, true)
  assert.equal(h.status.value, 'paused')
  assert.equal(h.track.listenerCount(), 0)
  assert.equal(h.stream.listenerCount(), 0)
  assert.equal(h.track.stops, 0)
  h.togglePlay(); await h.flush()
  assert.equal(h.status.value, 'playing')
  h.dispose()
  assert.equal(next.track.stops, 0)
})

test('延迟play完成在手动暂停、inactive或卸载后不复活播放或诊断', async t => {
  for (const cancel of [h => h.togglePlay(), h => { h.props.active = false }, h => h.dispose()]) {
    const result = deferred()
    const h = harness(t, { play: () => result.promise })
    await h.flush()
    assert.equal(h.playLabel.value, '暂停')
    cancel(h)
    const reports = h.reports().length
    h.video.paused = false
    result.resolve(); await h.flush()
    assert.equal(h.video.paused, true)
    assert.equal(h.time.timers.size, 0)
    assert.equal(h.frames.size, 0)
    assert.equal(h.reports().length, reports)
  }
})

test('旧流的延迟play拒绝或完成不会污染新流，旧重试不能接管新流', async t => {
  for (const reject of [false, true]) {
    const old = deferred()
    const h = harness(t, { play: (_video, number) => number === 1 ? old.promise : Promise.resolve() })
    await h.flush()
    const next = media(); h.props.stream = next.stream; await h.flush()
    if (reject) old.reject(Object.assign(new Error('blocked old'), { name: 'NotAllowedError' }))
    else old.resolve()
    await h.flush()
    assert.equal(h.status.value, 'playing')
    assert.equal(h.video.srcObject, next.stream)
    assert.equal(h.video.paused, false)
    assert.equal(h.time.timers.size, 1)
    assert.equal(h.frames.size, 1)
  }
})

test('浏览器自动播放拒绝准确提示blocked，不通过metadata自动重试，用户播放可恢复', async t => {
  const h = harness(t, { play: (video, number) => number === 1 ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : Promise.resolve() })
  await h.flush()
  assert.equal(h.status.value, 'blocked')
  assert.match(h.statusLabel.value, /浏览器阻止/)
  h.video.dispatch('canplay'); h.video.dispatch('loadedmetadata')
  h.props.active = false; h.props.active = true; await h.flush()
  assert.equal(h.status.value, 'blocked')
  assert.equal(h.playCalls, 1)
  h.togglePlay(); await h.flush()
  assert.equal(h.status.value, 'playing')
})

test('暂时play中断的重试在换流、暂停及卸载后取消，延迟已捕获回调也无作用', async t => {
  for (const cancel of [h => { h.props.stream = media().stream }, h => { h.props.active = false }, h => h.dispose()]) {
    const h = harness(t, { play: (_video, number) => number === 1 ? Promise.reject(Object.assign(new Error('not ready'), { name: 'AbortError' })) : Promise.resolve() })
    await h.flush()
    const retry = [...h.time.timers.values()][0].callback
    cancel(h); await h.flush()
    const plays = h.playCalls
    retry(); await h.flush()
    assert.equal(h.playCalls, plays)
  }
})

test('静态或纯黑内容保留playing，帧计数来自实际API，不把currentTime轮询当fps', async t => {
  const h = harness(t)
  await h.flush()
  h.frame({ presentedFrames: 18, width: 1920, height: 1080 })
  h.time.advance(1000)
  assert.equal(h.framesPresented.value, 18)
  assert.equal(h.fps.value, 1)
  h.frame({ presentedFrames: 42 })
  h.time.advance(1000)
  assert.equal(h.fps.value, 24, '以实际presentedFrames增量计算，包含两次callback间已显示的帧')
  h.time.advance(20000)
  assert.equal(h.status.value, 'playing')
  assert.equal(h.refreshes(), 0)
  assert.equal(h.fps.value, 0)
  const noApi = harness(t, { frameApi: false })
  await noApi.flush(); noApi.video.currentTime = 100; noApi.time.advance(1000)
  assert.equal(noApi.fps.value, null)
  assert.equal(noApi.framesPresented.value, null)
})

test('播放质量API提供真实总帧数与fps，渲染分辨率按视频元素刷新', async t => {
  let total = 20
  const h = harness(t, { frameApi: false, quality: () => ({ totalVideoFrames: total }) })
  await h.flush()
  total = 44; h.video.videoWidth = 1920; h.video.videoHeight = 1080; h.time.advance(1000)
  assert.equal(h.fps.value, 24)
  assert.equal(h.framesPresented.value, 44)
  const report = h.reports().at(-1)
  assert.equal(report.width, 1920)
  assert.equal(report.height, 1080)
  assert.equal(report.fps, 24)
})

test('播放质量统计不把未呈现的丢帧计入观看fps或framesPresented', async t => {
  let total = 20, dropped = 5
  const h = harness(t, { frameApi: false, quality: () => ({ totalVideoFrames: total, droppedVideoFrames: dropped }) })
  await h.flush()
  total = 50; dropped = 8; h.time.advance(1000)
  assert.equal(h.framesPresented.value, 42)
  assert.equal(h.fps.value, 27)
})

test('仅可见活动远端缺少可播放数据时尝试一次刷新，local及muted轨道不自动刷新', async t => {
  for (const mode of ['remote', 'local', 'muted']) {
    const h = harness(t, { readyState: 0, local: mode === 'local' })
    if (mode === 'muted') h.track.muted = true
    await h.flush(); h.time.advance(15000)
    assert.equal(h.status.value, 'stalled')
    assert.equal(h.refreshes(), mode === 'remote' ? 1 : 0)
    h.props.active = false; h.time.advance(15000)
    assert.equal(h.status.value, 'paused')
    assert.equal(h.refreshes(), mode === 'remote' ? 1 : 0)
  }
})

test('首帧缺失导致play等待时报告stalled并仅刷新一次，暂停后迟到完成不恢复', async t => {
  const pending = deferred()
  const h = harness(t, { readyState: 0, play: video => { video.paused = true; return pending.promise } })
  await h.flush()
  h.time.advance(8000)
  assert.equal(h.status.value, 'stalled')
  assert.equal(h.refreshes(), 1)
  h.togglePlay()
  assert.equal(h.status.value, 'paused')
  assert.equal(h.time.timers.size, 0)
  assert.equal(h.frames.size, 0)
  h.video.paused = false; pending.resolve(); await h.flush()
  assert.equal(h.video.paused, true)
  assert.equal(h.status.value, 'paused')
})

test('已取消的frame callback与interval、旧轨结束事件不会污染下一流或卸载状态', async t => {
  const h = harness(t)
  await h.flush()
  const oldFrame = [...h.frames.values()][0], oldInterval = [...h.time.timers.values()][0].callback
  const oldEnded = [...h.track.listeners.get('ended')][0]
  const next = media(); h.props.stream = next.stream; await h.flush()
  const reports = h.reports().length
  oldFrame(0, { presentedFrames: 99, width: 99, height: 99 }); oldInterval(); oldEnded()
  assert.equal(h.reports().length, reports)
  assert.notEqual(h.framesPresented.value, 99)
  assert.equal(h.status.value, 'playing')
  const nextFrame = [...h.frames.values()][0]
  h.dispose(); const after = h.reports().length
  nextFrame(0, { presentedFrames: 88, width: 88, height: 88 }); oldInterval()
  assert.equal(h.reports().length, after)
  assert.equal(h.time.timers.size, 0)
  assert.equal(h.frames.size, 0)
  assert.equal(h.video.listenerCount(), 0)
  assert.equal(h.document.listenerCount(), 0)
  assert.equal(next.track.listenerCount(), 0)
  assert.equal(next.track.stops, 0)
})

test('同步消费播放诊断切换active后不再启动旧play或重新挂frame callback', async t => {
  let loading
  loading = harness(t, { readyState: 1, emit: (event, value) => { if (loading && event === 'playback' && value.status === 'loading') loading.props.active = false } })
  await loading.flush()
  assert.equal(loading.playCalls, 0)
  assert.equal(loading.status.value, 'paused')
  let firstFrame
  firstFrame = harness(t, { readyState: 0, emit: (event, value) => { if (firstFrame && event === 'playback' && value.status === 'playing') firstFrame.props.active = false } })
  await firstFrame.flush()
  firstFrame.frame()
  assert.equal(firstFrame.status.value, 'paused')
  assert.equal(firstFrame.frames.size, 0)
  assert.equal(firstFrame.time.timers.size, 0)
})

test('轨道结束与媒体错误准确报告，不误标黑屏或停止调用方轨道', async t => {
  const h = harness(t)
  await h.flush()
  h.track.readyState = 'ended'; h.track.dispatch('ended')
  assert.equal(h.status.value, 'ended')
  assert.equal(h.video.paused, true)
  assert.equal(h.track.stops, 0)
  const next = media(); h.props.stream = next.stream; await h.flush()
  assert.equal(h.status.value, 'playing')
  h.video.error = { code: 3 }; h.video.dispatch('error')
  assert.equal(h.status.value, 'error')
  assert.match(h.statusLabel.value, /播放出错/)
})

test('全屏仅反映本播放器，命令拒绝有提示且不改变播放状态', async t => {
  const h = harness(t, { fullscreen: async () => { throw new Error('denied') } })
  await h.flush()
  h.document.fullscreenElement = {}; h.document.dispatch('fullscreenchange')
  assert.equal(h.isFullscreen.value, false)
  await h.toggleFullscreen()
  assert.match(h.fullscreenError.value, /未能进入全屏/)
  assert.equal(h.fullscreenPending.value, false)
  assert.equal(h.status.value, 'playing')
  assert.equal(h.exits, 0, '不退出其他播放器的全屏')
})

test('延迟全屏成功在inactive、换流或卸载后退出旧全屏，不污染新生命周期', async t => {
  for (const cancel of [h => { h.props.active = false }, h => { h.props.stream = media().stream }, h => { h.videoRef.value = null; h.containerRef.value = null; h.dispose() }]) {
    const pending = deferred()
    const h = harness(t, { fullscreen: async (container, document) => { await pending.promise; document.fullscreenElement = container } })
    await h.flush()
    const fullscreen = h.toggleFullscreen()
    cancel(h)
    pending.resolve(); await fullscreen; await h.flush()
    assert.equal(h.document.fullscreenElement, null)
    assert.equal(h.exits, 1)
    assert.equal(h.isFullscreen.value, false)
  }
})

test('Safari原生全屏同步失败与退出失败有提示，生命周期清除状态监听', async t => {
  const h = harness(t)
  await h.flush()
  delete h.container.requestFullscreen
  h.video.webkitEnterFullscreen = () => { throw new Error('native denied') }
  await h.toggleFullscreen()
  assert.match(h.fullscreenError.value, /未能进入全屏/)
  h.video.webkitDisplayingFullscreen = true; h.video.dispatch('webkitbeginfullscreen')
  assert.equal(h.isFullscreen.value, true)
  h.video.webkitExitFullscreen = () => { throw new Error('native denied exit') }
  await h.toggleFullscreen()
  assert.match(h.fullscreenError.value, /无法退出全屏/)
  h.video.webkitDisplayingFullscreen = false; h.video.dispatch('webkitendfullscreen')
  assert.equal(h.isFullscreen.value, false)
})

test('active切换后的旧全屏完成不能退出用户新发起的全屏', async t => {
  const requests = [deferred(), deferred()]
  let index = 0
  const h = harness(t, { fullscreen: async (container, document) => { const request = requests[index++]; await request.promise; document.fullscreenElement = container; document.dispatch('fullscreenchange') } })
  await h.flush()
  const old = h.toggleFullscreen()
  h.props.active = false; h.props.active = true; await h.flush()
  const latest = h.toggleFullscreen()
  requests[0].resolve(); await old
  assert.equal(h.exits, 0)
  requests[1].resolve(); await latest
  assert.equal(h.isFullscreen.value, true)
  assert.equal(h.document.fullscreenElement, h.container)
})
