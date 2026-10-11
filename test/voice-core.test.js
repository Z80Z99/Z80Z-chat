import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'

const transpiledModules = new Map()
const transpile = url => ts.transpileModule(readFileSync(url, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function harness({ connected = true, storageValues = {}, sinkSupported = true, webAudioSupported = true } = {}) {
  const auth = Vue.reactive({ user: { id: 'a-user' } })
  const storage = new Map([['token', 'token-a'], ...Object.entries(storageValues)])
  const mediaRequests = [], displayRequests = [], peers = [], processed = [], contexts = [], sounds = [], elements = [], sent = [], queued = []
  const connectionListeners = new Set(), windowListeners = new Map(), timers = new Map(), sinkBlocks = new Map(), logs = []
  let timerId = 0, createOfferBlock = null, remoteDescriptionBlock = null, statsBlock = null, replaceBlock = null
  class Track {
    constructor(kind = 'audio', id = 'track') { this.kind = kind; this.id = id; this.enabled = true; this.readyState = 'live'; this.listeners = new Map() }
    stop() { this.readyState = 'ended'; this.stopped = true }
    addEventListener(type, fn) { this.listeners.set(type, fn) }
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type) }
    applyConstraints(value) { this.constraints = [...(this.constraints || []), value]; return this.constraintsDeferred?.promise || Promise.resolve() }
    getSettings() { return { width: 1920, height: 1080, frameRate: 30 } }
  }
  class Stream {
    constructor(tracks = [new Track()]) { this.tracks = tracks }
    getTracks() { return this.tracks }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
  }
  class Node {
    constructor(type) { this.type = type; this.connections = []; this.gain = { value: 1, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }; this.frequency = { value: 0 }; this.fftSize = 512 }
    connect(node) { this.connections.push(node) }
    disconnect() { this.disconnected = true }
    getByteTimeDomainData(array) { array.fill(128) }
    start() {}
    stop() {}
  }
  class AudioContext {
    constructor() { if (!webAudioSupported) throw new Error('Web Audio unavailable'); this.state = 'running'; this.currentTime = 0; contexts.push(this) }
    createGain() { return new Node('gain') }
    createAnalyser() { return new Node('analyser') }
    createMediaStreamSource() { return new Node('source') }
    createMediaStreamDestination() { const node = new Node('destination'); const track = new Track('audio', 'processed'); node.stream = new Stream([track]); processed.push(track); return node }
    createOscillator() { const node = new Node('oscillator'); sounds.push(node); return node }
    resume() { this.state = 'running'; return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  class AudioElement {
    constructor() { this.volume = 1; this.dataset = {}; this.paused = true; this.playCount = 0; this.srcObject = null; this.failPlay = false; if (!sinkSupported) this.setSinkId = undefined; elements.push(this) }
    async setSinkId(id) { this.sinkCalls = [...(this.sinkCalls || []), id]; if (sinkBlocks.has(id)) await sinkBlocks.get(id).promise; this.sink = id }
    play() { this.playCount++; this.paused = false; return this.playDeferred?.promise || (this.failPlay ? Promise.reject(new Error('autoplay')) : Promise.resolve()) }
    pause() { this.paused = true }
    remove() { this.removed = true }
  }
  class Sender {
    constructor(track = null) { this.track = track; this.replacements = [] }
    async replaceTrack(track) { this.replacements.push({ track, enabled: track?.enabled }); const block = this.replaceDeferred || replaceBlock; if (block) await block.promise; this.track = track }
    getParameters() { return { encodings: [{}] } }
    setParameters(value) { this.parameterChanges = [...(this.parameterChanges || []), JSON.parse(JSON.stringify(value))]; return Promise.resolve() }
  }
  class Peer {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.senders = []; this.transceivers = []; peers.push(this) }
    addTrack(track) { const sender = new Sender(track); this.senders.push(sender); return sender }
    addTransceiver(kind, options = {}) { const tr = { direction: options.direction, receiver: { track: new Track(kind) }, sender: new Sender(), setCodecPreferences() {} }; this.transceivers.push(tr); return tr }
    getSenders() { return this.senders }
    getTransceivers() { return this.transceivers }
    async createOffer() { const block = this.offerDeferred || createOfferBlock; if (block) await block.promise; this.offers = (this.offers || 0) + 1; return { type: 'offer', sdp: 'offer' } }
    async createAnswer() { this.answers = (this.answers || 0) + 1; if (this.answerDeferred) await this.answerDeferred.promise; return { type: 'answer', sdp: 'answer' } }
    async setRemoteDescription(description) { const block = this.descriptionDeferred || remoteDescriptionBlock; if (block) await block.promise; this.remoteDescription = description }
    setLocalDescription(description) { this.localDescription = description; return Promise.resolve() }
    async addIceCandidate(candidate) { this.iceCandidates = [...(this.iceCandidates || []), candidate]; this.iceCount = (this.iceCount || 0) + 1; if (this.iceDeferred) await this.iceDeferred.promise }
    getStats() { this.statsCalls = (this.statsCalls || 0) + 1; return this.statsDeferred?.promise || (statsBlock ? statsBlock.promise : Promise.resolve(this.statsReport || new Map())) }
    close() { this.closed = true; this.signalingState = 'closed' }
  }
  const ws = {
    isConnected: () => connected,
    onConnectionChange(fn) { connectionListeners.add(fn); fn(connected) }, offConnectionChange(fn) { connectionListeners.delete(fn) },
    send(data) { (connected ? sent : queued).push(data) }
  }
  const window = {
    addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn) },
    removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn) }
  }
  const context = {
    console: { ...console, error: (...args) => logs.push(args) }, window, document: { createElement: () => new AudioElement(), body: { appendChild(el) { el.appended = true } } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { hardwareConcurrency: 8, mediaDevices: {
      getUserMedia: constraints => { const request = deferred(); mediaRequests.push({ ...request, constraints }); return request.promise },
      getDisplayMedia: constraints => { const request = deferred(); displayRequests.push({ ...request, constraints }); return request.promise },
      enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: 'mic-a' }, { kind: 'audiooutput', deviceId: 'speaker-a' }])
    } },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ iceServers: [{ urls: 'stun:test' }] }) }),
    AudioContext, Audio: AudioElement, HTMLMediaElement: AudioElement, MediaStream: Stream,
    RTCPeerConnection: Peer, RTCRtpSender: { getCapabilities: () => null }, RTCSessionDescription: class { constructor(value) { Object.assign(this, value) } }, RTCIceCandidate: class { constructor(value) { Object.assign(this, value) } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, interval: false }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, interval: true }); return id },
    clearInterval(id) { timers.delete(id) }
  }
  // Each harness has its own module cache, while every module uses the same
  // browser context. Controllers must never import another harness's globals.
  const browserContext = vm.createContext(context)
  const modules = new Map([
    [new URL('../frontend/src/stores/auth.ts', import.meta.url).href, { exports: { useAuthStore: () => auth } }],
    [new URL('../frontend/src/utils/ws.ts', import.meta.url).href, { exports: { ws } }]
  ])
  function loadModule(url) {
    if (modules.has(url.href)) return modules.get(url.href).exports
    const module = { exports: {} }
    modules.set(url.href, module)
    if (!transpiledModules.has(url.href)) transpiledModules.set(url.href, transpile(url))
    const wrapper = vm.runInContext(`(function(exports, module, require) {\n${transpiledModules.get(url.href)}\n})`, browserContext, { filename: url.pathname })
    wrapper(module.exports, module, name => {
      if (name === 'vue') return Vue
      if (name === 'pinia') return Pinia
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
      return loadModule(new URL(/\.[jt]s$/.test(name) ? name : `${name}.ts`, url))
    })
    return module.exports
  }
  const voiceModule = loadModule(new URL('../frontend/src/stores/voice.ts', import.meta.url))
  const piniaInstances = []
  function newStore() {
    const pinia = Pinia.createPinia(); Pinia.setActivePinia(pinia)
    piniaInstances.push(pinia)
    return voiceModule.useVoiceStore()
  }
  const store = newStore()
  const stream = (kind = 'audio', id = 'raw') => new Stream([new Track(kind, id)])
  return {
    store, newStore, auth, storage, mediaRequests, displayRequests, peers, processed, contexts, sounds, elements, sent, queued, timers, windowListeners, connectionListeners, stream,
    async join(room = 'room-a', state) { const previousStream = store.localStream; const promise = store.joinRoom(room, state); await settle(); if (previousStream) { await promise; return previousStream } const raw = stream(); mediaRequests.at(-1).resolve(raw); await promise; return raw },
    connect(value) { connected = value; for (const fn of connectionListeners) fn(value) },
    blockOffer(peer) { return peer ? peer.offerDeferred = deferred() : createOfferBlock = deferred() },
    blockDescription(peer) { return peer ? peer.descriptionDeferred = deferred() : remoteDescriptionBlock = deferred() },
    blockAnswer(peer) { return peer.answerDeferred = deferred() }, blockIce(peer) { return peer.iceDeferred = deferred() },
    blockConstraints(track) { return track.constraintsDeferred = deferred() },
    blockStats() { return statsBlock = deferred() }, blockReplace(sender) { return sender ? sender.replaceDeferred = deferred() : replaceBlock = deferred() },
    blockSink(id) { const block = deferred(); sinkBlocks.set(id, block); return block }, logs,
    remoteAudio(peer = peers.at(-1), id = 'remote') { const remote = stream('audio', id); peer.ontrack({ track: remote.getAudioTracks()[0], streams: [remote] }); return { element: elements.at(-1), track: remote.getAudioTracks()[0] } },
    async tick(delay) { for (const [id, timer] of [...timers]) { if (timer.delay !== delay) continue; if (!timer.interval) timers.delete(id); await timer.fn() } await settle() },
    cleanup() { piniaInstances.forEach(pinia => Pinia.disposePinia(pinia)) }
  }
}

test('开放麦默认100%，PTT门控同时控制原始与处理轨，静音与耳聋不会被按键覆盖', async () => {
  const h = harness()
  try {
    const raw = await h.join()
    const track = raw.getAudioTracks()[0]
    assert.equal(h.store.isTransmitting, true)
    assert.equal(track.enabled, true)
    assert.equal(h.processed.at(-1).enabled, true)
    h.store.setVoiceMode('push-to-talk')
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(track.enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.isTransmitting, true)
    assert.equal(h.store.isMuted, false)
    h.store.toggleMute()
    assert.equal(h.store.pushToTalkPressed, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.isTransmitting, false)
    h.store.toggleMute()
    assert.equal(track.enabled, false)
    h.store.setPushToTalkPressed(true)
    h.store.toggleDeafen()
    assert.equal(h.processed.at(-1).enabled, false)
    assert.equal(h.store.pushToTalkPressed, false)
    h.store.toggleDeafen()
    assert.equal(h.store.isTransmitting, false)
    h.store.setPushToTalkPressed(true)
    h.store.setPushToTalkKey('KeyV')
    assert.equal(h.store.isTransmitting, false)
    assert.equal(h.store.pushToTalkKey, 'KeyV')
  } finally { h.cleanup() }
})

test('按人音量乘全局音量，100%封顶，新轨和耳聋恢复始终使用当前偏好', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    h.store.setUserVolume('z-peer', 0.4)
    h.store.setOutputVolume(0.5)
    const { element } = h.remoteAudio()
    assert.equal(element.volume, 0.2)
    h.store.toggleDeafen()
    h.store.setUserVolume('z-peer', 0.3)
    h.store.setOutputVolume(2)
    assert.equal(h.store.outputVolume, 1)
    assert.equal(element.volume, 0)
    h.store.toggleDeafen()
    assert.equal(element.volume, 0.3)
    await h.store.changeOutputDevice('headset')
    assert.equal(element.volume, 0.3)
    assert.equal(element.sink, 'headset')
    const replacement = h.remoteAudio()
    assert.equal(element.removed, true)
    assert.equal(element.srcObject, null)
    assert.equal(replacement.element.volume, 0.3)
    h.store.setUserVolume('z-peer', -10)
    assert.equal(replacement.element.volume, 0)
    h.store.setUserVolume('z-peer', NaN)
    assert.equal(replacement.element.volume, 1)
  } finally { h.cleanup() }
})

test('保存模式与成员音量按账号隔离，切换账号立即停轨、离房、释放PTT', async () => {
  const h = harness()
  try {
    const raw = await h.join()
    h.store.setVoiceMode('push-to-talk'); h.store.setPushToTalkKey('ArrowUp'); h.store.setUserVolume('z-peer', 0.25)
    h.store.setPushToTalkPressed(true)
    h.storage.set('token', 'token-b'); h.auth.user = { id: 'b-user' }
    assert.equal(h.store.currentRoom, null)
    assert.equal(raw.getAudioTracks()[0].stopped, true)
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(h.store.voiceMode, 'open')
    assert.equal(h.store.getUserVolume('z-peer'), 1)
    h.store.setUserVolume('z-peer', 0.75)
    h.storage.set('token', 'token-a'); h.auth.user = { id: 'a-user' }
    assert.equal(h.store.voiceMode, 'push-to-talk')
    assert.equal(h.store.pushToTalkKey, 'ArrowUp')
    assert.equal(h.store.getUserVolume('z-peer'), 0.25)
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(JSON.parse(h.storage.get('z80z-chat_voice_preferences_b-user')).userVolumes['z-peer'], 0.75)
  } finally { h.cleanup() }
})

test('离房期间迟到的 getUserMedia 停止所有轨，不能发送 join 或重建音频管线', async () => {
  const h = harness()
  try {
    const join = h.store.joinRoom('room-a'); await settle()
    h.store.leaveRoom()
    const raw = h.stream(); h.mediaRequests[0].resolve(raw); await join
    assert.equal(raw.getAudioTracks()[0].stopped, true)
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.store.localStream, null)
    assert.equal(h.processed.length, 0)
    assert.equal(h.sent.some(event => event.type === 'voice-join'), false)
  } finally { h.cleanup() }
})

test('快速换房时新房先完成，旧麦克风权限响应不能覆盖新会话', async () => {
  const h = harness()
  try {
    const first = h.store.joinRoom('room-a'); await settle()
    const second = h.store.joinRoom('room-b'); await settle()
    const newest = h.stream('audio', 'new'); h.mediaRequests[1].resolve(newest); await second
    const stale = h.stream('audio', 'old'); h.mediaRequests[0].resolve(stale); await first
    assert.equal(h.store.currentRoom, 'room-b')
    assert.equal(h.store.localStream.getAudioTracks()[0].id, 'new')
    assert.equal(stale.getAudioTracks()[0].stopped, true)
    assert.deepEqual(h.sent.filter(event => event.type === 'voice-join').map(event => event.roomId), ['room-b'])
  } finally { h.cleanup() }
})

test('账号退出取消等待中的麦克风请求，其他账号不继承媒体', async () => {
  const h = harness()
  try {
    const join = h.store.joinRoom('room-a'); await settle()
    h.auth.user = null
    const stale = h.stream(); h.mediaRequests[0].resolve(stale); await join
    assert.equal(stale.getAudioTracks()[0].stopped, true)
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.sent.some(event => event.type === 'voice-join'), false)
  } finally { h.cleanup() }
})

test('切换输入期间 gate 关闭，processed replaceTrack 全程禁用，成功后仍需重新按键', async () => {
  const h = harness()
  try {
    const raw = await h.join(); await h.store.createOffer('z-peer')
    h.store.setVoiceMode('push-to-talk'); h.store.setPushToTalkPressed(true)
    const blocked = h.blockReplace()
    const change = h.store.changeInputDevice('mic-b')
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
    const newest = h.stream(); h.mediaRequests.at(-1).resolve(newest); await settle()
    assert.equal(newest.getAudioTracks()[0].enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
    assert.ok(h.peers[0].getSenders()[0].replacements.every(record => !record.enabled))
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.pushToTalkPressed, false)
    blocked.resolve(); await change
    assert.equal(h.store.isTransmitting, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.isTransmitting, true)
    assert.equal(h.processed.at(-1).enabled, true)
  } finally { h.cleanup() }
})

test('输入设备迟到与 retryMic 被离房失效，收到新轨也停止且不创建 sender', async () => {
  const h = harness()
  try {
    await h.join()
    const change = h.store.changeInputDevice('mic-b')
    h.store.leaveRoom()
    const stale = h.stream(); h.mediaRequests.at(-1).resolve(stale); await change
    assert.equal(stale.getAudioTracks()[0].stopped, true)
    assert.equal(h.store.currentRoom, null)
    await h.join()
    const retry = h.store.retryMic()
    h.store.leaveRoom()
    const retryStream = h.stream(); h.mediaRequests.at(-1).resolve(retryStream); await retry
    assert.equal(retryStream.getAudioTracks()[0].stopped, true)
    assert.equal(h.store.localStream, null)
  } finally { h.cleanup() }
})

test('断线立即关闭发言，重连不恢复按下状态，离线 leave/control 不排队', async () => {
  const h = harness()
  try {
    const raw = await h.join(); h.store.setVoiceMode('push-to-talk'); h.store.setPushToTalkPressed(true)
    h.connect(false)
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
    h.connect(true); await h.store.rejoinRoom('room-a')
    assert.equal(h.store.isTransmitting, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.isTransmitting, true)
    h.connect(false); h.store.toggleMute(); h.store.leaveRoom()
    assert.equal(h.queued.length, 0)
    h.connect(true); await h.store.rejoinRoom('room-a')
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.sent.filter(event => event.type === 'voice-join').length, 2)
  } finally { h.cleanup() }
})

test('初次 WebSocket 尚未连接时可准备听筒，首次 open 补 join 且不泄漏麦克风', async () => {
  const h = harness({ connected: false })
  try {
    const raw = await h.join()
    assert.equal(h.store.isTransmitting, false)
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.queued.length, 0)
    h.connect(true)
    assert.equal(h.store.isTransmitting, true)
    assert.equal(h.sent.filter(event => event.type === 'voice-join').length, 1)
  } finally { h.cleanup() }
})

test('迟到的 offer 与 remoteDescription 不会向换房后的房间答复或写候选队列', async () => {
  const h = harness()
  try {
    await h.join()
    const offer = h.blockOffer(); const sending = h.store.createOffer('z-peer')
    h.store.leaveRoom(); offer.resolve(); await sending
    assert.equal(h.sent.some(event => event.type === 'voice-offer'), false)
    await h.join('room-b')
    const desc = h.blockDescription()
    h.store.handleSignal({ type: 'voice-offer', roomId: 'room-b', userId: 'z-peer', data: { type: 'offer', sdp: 'remote' } })
    const peer = h.peers.at(-1)
    h.store.leaveRoom(); desc.resolve(); await settle()
    assert.equal(peer.answers || 0, 0)
    assert.equal(h.sent.some(event => event.type === 'voice-answer'), false)
  } finally { h.cleanup() }
})

test('旧 stats Promise 不能复活离房后的质量指标，重连定时器与播放重试会清理', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const { element, track } = h.remoteAudio(); element.failPlay = true; track.listeners.get('unmute')(); await settle()
    h.peers[0].connectionState = 'failed'; h.peers[0].onconnectionstatechange()
    assert.ok([...h.timers.values()].some(timer => timer.delay === 1000))
    const stats = h.blockStats()
    const polling = h.tick(2000)
    await settle()
    h.store.leaveRoom()
    stats.resolve(new Map([['rtt', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.25 }]])); await polling
    assert.equal(h.store.connectionStats.rtt, 0)
    assert.equal(h.store.connectionStats.quality, 'unknown')
    assert.equal(element.removed, true)
    assert.equal(element.srcObject, null)
    assert.equal(track.listeners.size, 0)
    assert.equal(h.timers.size, 0)
  } finally { h.cleanup() }
})

test('停止远程投屏保留同人的语音，离开成员才清除音频与连接', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const { element } = h.remoteAudio()
    const video = h.stream('video'); h.peers[0].ontrack({ track: video.getVideoTracks()[0], streams: [video] })
    h.store.cleanupRemoteScreen('z-peer')
    assert.equal(h.store.remoteScreens.length, 0)
    assert.equal(element.removed, undefined)
    h.store.cleanupPeer('z-peer')
    assert.equal(element.removed, true)
    assert.equal(h.peers[0].closed, true)
    assert.equal(h.store.peerConnections.size, 0)
  } finally { h.cleanup() }
})

test('迟到的投屏选择器响应不会在离房后恢复分享，本地检查音不进入麦克风发送管线', async () => {
  const h = harness()
  try {
    await h.join(); h.store.playTestSound(1)
    assert.equal(h.sounds.length, 1)
    assert.equal(h.sounds[0].connections[0].connections[0].type, 'destination')
    const share = h.store.startScreenShare(); h.store.leaveRoom()
    const stale = h.stream('video'); h.displayRequests[0].resolve(stale); await share
    assert.equal(stale.getVideoTracks()[0].stopped, true)
    assert.equal(h.store.isScreenSharing, false)
    assert.equal(h.sent.some(event => event.type === 'screen-share-start'), false)
  } finally { h.cleanup() }
})

test('损坏偏好安全降级，键校验与UI一致，dispose移除连接与窗口监听', () => {
  const h = harness({ storageValues: { 'z80z-chat_voice_preferences_a-user': JSON.stringify({ voiceMode: 'bad', pushToTalkKey: 'Tab', outputVolume: 10, userVolumes: { peer: -1, constructor: 0.4 } }) } })
  try {
    assert.equal(h.store.voiceMode, 'open')
    assert.equal(h.store.pushToTalkKey, 'Space')
    assert.equal(h.store.outputVolume, 1)
    assert.equal(h.store.getUserVolume('peer'), 0)
    h.store.setPushToTalkKey('Enter'); assert.equal(h.store.pushToTalkKey, 'Enter')
    h.store.setPushToTalkKey('ControlLeft'); assert.equal(h.store.pushToTalkKey, 'Space')
  } finally { h.cleanup() }
  assert.equal(h.connectionListeners.size, 0)
  assert.ok([...h.windowListeners.values()].every(listeners => listeners.size === 0))
})

test('刷新恢复的手动静音和耳聋在新processed轨创建前生效，切房保留状态', async () => {
  const h = harness()
  try {
    const raw = await h.join('saved-room', { isMuted: true, isDeafened: true })
    assert.equal(h.store.isMuted, true)
    assert.equal(h.store.isDeafened, true)
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
    await h.store.joinRoom('next-room')
    assert.equal(h.store.isMuted, true)
    assert.equal(h.store.isDeafened, true)
    assert.equal(h.processed.at(-1).enabled, false)
    h.store.toggleDeafen()
    assert.equal(h.store.isTransmitting, false)
    h.store.toggleMute()
    assert.equal(h.store.isTransmitting, true)
  } finally { h.cleanup() }
})

test('刷新恢复PTT偏好从未恢复pressed，第一次按键前保持静音', async () => {
  const h = harness({ storageValues: { 'z80z-chat_voice_preferences_a-user': JSON.stringify({ voiceMode: 'push-to-talk', pushToTalkKey: 'KeyV', pushToTalkPressed: true }) } })
  try {
    const raw = await h.join('saved-room', { isMuted: false, isDeafened: false })
    assert.equal(h.store.voiceMode, 'push-to-talk')
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
  } finally { h.cleanup() }
})

test('本地音效跟随全局音量和耳聋，离房清定时器/音轨并关闭独立context', async () => {
  const h = harness()
  try {
    await h.join()
    const micContext = h.contexts.find(ctx => ctx.state === 'running')
    h.store.setOutputVolume(0.3); h.store.playSystemTone('enter')
    const element = h.elements.at(-1), toneContext = h.contexts.at(-1), toneStream = element.srcObject
    assert.equal(element.volume, 0.3)
    assert.notEqual(toneContext, micContext)
    h.store.setOutputVolume(0.6); assert.equal(element.volume, 0.6)
    h.store.toggleDeafen()
    assert.equal(element.srcObject, null)
    assert.equal(element.paused, true)
    assert.equal(toneStream.getTracks()[0].stopped, true)
    assert.equal(toneContext.state, 'closed')
    const count = h.elements.length
    h.store.playSystemTone('mute'); assert.equal(h.elements.length, count)
    h.store.toggleDeafen(); h.store.playSystemTone('unmute')
    const active = h.elements.at(-1), activeContext = h.contexts.at(-1), activeStream = active.srcObject
    h.store.leaveRoom()
    assert.equal(active.srcObject, null)
    assert.equal(activeStream.getTracks()[0].stopped, true)
    assert.equal(activeContext.state, 'closed')
    assert.equal(h.timers.size, 0)
  } finally { h.cleanup() }
})

test('不支持setSinkId的浏览器仍能播放远端语音和本地音效', async () => {
  const h = harness({ sinkSupported: false })
  try {
    await h.join(); await h.store.createOffer('z-peer')
    assert.equal(h.store.outputDeviceId, 'speaker-a')
    const { element } = h.remoteAudio()
    assert.equal(element.appended, true)
    assert.equal(element.playCount, 1)
    h.store.playSystemTone('enter')
    assert.equal(h.elements.at(-1).playCount, 1)
    await h.store.changeOutputDevice('headset')
  } finally { h.cleanup() }
})

test('当前麦克风拔出关闭raw与processed门控，旧设备ended事件不能污染新设备', async () => {
  const h = harness()
  try {
    const raw = await h.join()
    const oldTrack = raw.getAudioTracks()[0], staleHandler = oldTrack.listeners.get('ended')
    const change = h.store.changeInputDevice('mic-b')
    const next = h.stream(); h.mediaRequests.at(-1).resolve(next); await change
    staleHandler()
    assert.equal(h.store.micAvailable, true)
    const current = next.getAudioTracks()[0]
    current.readyState = 'ended'; current.listeners.get('ended')()
    assert.equal(h.store.micAvailable, false)
    assert.equal(h.store.isTransmitting, false)
    assert.match(h.store.micError, /已断开/)
    assert.equal(current.enabled, false)
    assert.equal(h.processed.at(-1).enabled, false)
  } finally { h.cleanup() }
})

test('Web Audio不可用时直接麦克风轨仍遵守PTT，切换设备能替换sender', async () => {
  const h = harness({ webAudioSupported: false })
  try {
    const raw = await h.join(); await h.store.createOffer('z-peer')
    assert.equal(h.store.micAvailable, true)
    assert.equal(h.peers[0].getSenders()[0].track.id, 'raw')
    h.store.setVoiceMode('push-to-talk')
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(raw.getAudioTracks()[0].enabled, true)
    const change = h.store.changeInputDevice('mic-b')
    const next = h.stream('audio', 'next'); h.mediaRequests.at(-1).resolve(next); await change
    assert.equal(h.peers[0].getSenders()[0].track.id, 'next')
    assert.equal(next.getAudioTracks()[0].enabled, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(next.getAudioTracks()[0].enabled, true)
  } finally { h.cleanup() }
})

test('新账号的初次socket打开仍可完成待加入语音，不继承旧账号连接标记', async () => {
  const h = harness()
  try {
    h.connect(false); h.auth.user = null
    h.storage.set('token', 'token-b'); h.auth.user = { id: 'b-user' }
    const raw = await h.join('room-b')
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    h.connect(true)
    assert.equal(h.store.currentRoom, 'room-b')
    assert.equal(h.store.isTransmitting, true)
    assert.equal(h.sent.filter(event => event.type === 'voice-join').length, 1)
  } finally { h.cleanup() }
})

test('快速输出设备切换串行应用，旧setSinkId晚完成不会覆盖新选择', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const { element } = h.remoteAudio(); await settle()
    const first = h.blockSink('old-headset')
    const oldChange = h.store.changeOutputDevice('old-headset'); await settle()
    const newestChange = h.store.changeOutputDevice('new-headset')
    first.resolve(); await oldChange; await newestChange
    assert.equal(h.store.outputDeviceId, 'new-headset')
    assert.equal(element.sink, 'new-headset')
  } finally { h.cleanup() }
})

test('仅能听的会话重连请求麦克风时离房，迟到响应不能再次加入', async () => {
  const h = harness()
  try {
    const first = h.store.joinRoom('room-a'); await settle()
    h.mediaRequests[0].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await first
    assert.equal(h.store.micAvailable, false)
    h.connect(false); h.connect(true)
    const reconnect = h.store.rejoinRoom('room-a'); await settle()
    h.store.leaveRoom()
    const late = h.stream(); h.mediaRequests[1].resolve(late); await reconnect
    assert.equal(late.getAudioTracks()[0].stopped, true)
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.sent.filter(event => event.type === 'voice-join').length, 1)
  } finally { h.cleanup() }
})

test('详细诊断仅面板启用时解析，逐peer采样不混用码率基线', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer'); await h.store.createOffer('y-peer')
    const first = h.peers[0], second = h.peers[1]
    first.statsReport = new Map([['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 10000, framesReceived: 30, framesDecoded: 25 }]])
    second.statsReport = new Map([['v2', { id: 'v2', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 900000, framesReceived: 300, framesDecoded: 260 }]])
    await h.tick(2000)
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
    h.store.setDiagnosticsEnabled(true); await settle()
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesReceived, 30)
    assert.equal(h.store.peerDiagnostics['y-peer'].videoIn.framesDecoded, 260)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.bitrateKbps, null)
    first.statsReport = new Map([['v1', { id: 'v1', type: 'inbound-rtp', kind: 'video', timestamp: 3000, bytesReceived: 30000, framesReceived: 90, framesDecoded: 85 }]])
    second.statsReport = new Map([['v2', { id: 'v2', type: 'inbound-rtp', kind: 'video', timestamp: 3000, bytesReceived: 1000000, framesReceived: 360, framesDecoded: 320 }]])
    await h.tick(2000)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.bitrateKbps, 80)
    assert.equal(h.store.peerDiagnostics['y-peer'].videoIn.bitrateKbps, 400)
    h.store.setDiagnosticsEnabled(false)
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
  } finally { h.cleanup() }
})

test('统计轮询单飞，关闭再打开诊断不会接收旧轮结果或旧基线', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const blocked = h.blockStats(), peer = h.peers[0]
    h.store.setDiagnosticsEnabled(true)
    const tick = h.tick(2000); await settle()
    assert.equal(peer.statsCalls, 1)
    h.store.setDiagnosticsEnabled(false); h.store.setDiagnosticsEnabled(true)
    blocked.resolve(new Map([['old', { id: 'old', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 999 }]])); await tick
    assert.equal(h.store.peerDiagnostics['z-peer'].sampledAt, null)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesDecoded, null)
    await h.tick(2000)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesDecoded, 999)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.bitrateKbps, null)
  } finally { h.cleanup() }
})

test('换房或退出账号后迟到stats不能恢复peer诊断；失败错误不暴露浏览器细节', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const blocked = h.blockStats()
    h.store.setDiagnosticsEnabled(true)
    const tick = h.tick(2000); await settle()
    h.auth.user = null
    blocked.reject(new Error('192.0.2.5 SDP token=secret')); await tick
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
    assert.equal(h.store.currentRoom, null)
  } finally { h.cleanup() }
  const failed = harness()
  try {
    await failed.join(); await failed.store.createOffer('z-peer')
    failed.peers[0].statsDeferred = deferred(); failed.store.setDiagnosticsEnabled(true)
    failed.peers[0].statsDeferred.reject(new Error('192.0.2.5 secret'))
    await settle()
    assert.equal(failed.store.peerDiagnostics['z-peer'].error, '浏览器暂未提供连接统计')
    assert.equal(JSON.stringify(failed.store.peerDiagnostics).includes('secret'), false)
  } finally { failed.cleanup() }
})

test('播放器状态独立于收帧统计，旧stream上报无效，诊断关闭不触发采集', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const peer = h.peers[0], oldStream = h.stream('video')
    peer.ontrack({ track: oldStream.getVideoTracks()[0], streams: [oldStream] })
    const payload = { status: 'blocked', paused: true, width: 0, height: 0, fps: null, framesPresented: null }
    h.store.reportScreenPlayback('z-peer', payload, oldStream)
    assert.equal(peer.statsCalls || 0, 0)
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
    h.store.setDiagnosticsEnabled(true); await settle()
    assert.equal(h.store.peerDiagnostics['z-peer'].playback.status, 'blocked')
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesDecoded, null)
    const replacement = h.stream('video'); peer.ontrack({ track: replacement.getVideoTracks()[0], streams: [replacement] })
    h.store.reportScreenPlayback('z-peer', { ...payload, status: 'playing', framesPresented: 500 }, oldStream)
    assert.equal(h.store.peerDiagnostics['z-peer'].playback, null)
    h.store.reportScreenPlayback('z-peer', { ...payload, status: 'playing', framesPresented: 3 }, replacement)
    assert.equal(h.store.peerDiagnostics['z-peer'].playback.framesPresented, 3)
    h.store.cleanupRemoteScreen('z-peer')
    assert.equal(h.store.peerDiagnostics['z-peer'].playback, null)
    h.store.reportScreenPlayback('z-peer', payload, replacement)
    assert.equal(h.store.peerDiagnostics['z-peer'].playback, null)
  } finally { h.cleanup() }
})

test('投屏刷新只协商目标成员，重复刷新不并发且离房迟到offer无效', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer'); await h.store.createOffer('y-peer')
    h.sent.length = 0
    await h.store.requestScreenRefresh('z-peer')
    assert.deepEqual(h.sent.filter(event => event.type === 'voice-offer').map(event => event.targetUserId), ['z-peer'])
    const blocked = h.blockOffer()
    const first = h.store.requestScreenRefresh('z-peer'), second = h.store.requestScreenRefresh('z-peer')
    await settle(); h.store.leaveRoom(); blocked.resolve(); await first; await second
    assert.equal(h.sent.filter(event => event.type === 'voice-offer').length, 1)
  } finally { h.cleanup() }
})

test('快速换房清除旧诊断，旧getStats未完成时不会并发采集新连接', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const blocked = h.blockStats()
    h.store.setDiagnosticsEnabled(true)
    const oldTick = h.tick(2000); await settle()
    await h.store.joinRoom('room-b'); await h.store.createOffer('z-peer')
    const fresh = h.peers.at(-1)
    const newest = deferred(); fresh.statsDeferred = newest
    assert.equal(fresh.statsCalls || 0, 0)
    assert.equal(h.store.peerDiagnostics['z-peer'].sampledAt, null)
    blocked.resolve(new Map([['stale', { id: 'stale', type: 'inbound-rtp', kind: 'video', framesDecoded: 999 }]])); await oldTick
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesDecoded, null)
    newest.resolve(new Map([['fresh', { id: 'fresh', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 5000, framesDecoded: 7 }]]))
    await h.tick(2000)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.framesDecoded, 7)
    assert.equal(h.store.peerDiagnostics['z-peer'].videoIn.bitrateKbps, null)
  } finally { h.cleanup() }
})

async function adaptiveSharing(h, peerIds = ['z-peer', 'y-peer']) {
  await h.join()
  for (const userId of peerIds) await h.store.createOffer(userId)
  const sharing = h.store.startScreenShare()
  h.displayRequests.at(-1).resolve(h.stream('video', 'screen'))
  await sharing
  return h.peers.map(peer => peer.getSenders().find(sender => sender.track?.kind === 'video'))
}

function healthReport(rttMs, fractionLost) {
  return new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { id: 'selected', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: rttMs / 1000 }],
    ['unused', { id: 'unused', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.001 }],
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', trackIdentifier: 'screen', transportId: 'transport', active: true,
      remoteId: 'remote', packetsSent: 100, packetsLost: 0, bytesSent: 10000 }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', localId: 'out', fractionLost }]
  ])
}
const maxBitrate = sender => sender.parameterChanges.at(-1).encodings[0].maxBitrate

test('自动码率使用最慢观看成员所选通路RTT，未选中的低RTT不掩盖400ms连接', async () => {
  const h = harness()
  try {
    const senders = await adaptiveSharing(h)
    h.peers[0].statsReport = healthReport(30, 0)
    h.peers[1].statsReport = healthReport(400, 0)
    await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
    assert.equal(h.store.connectionStats.rtt, 1)
    assert.equal(h.store.diagnosticsEnabled, false)
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
  } finally { h.cleanup() }
})

test('缺失remote丢包反馈不会假定零而升档，全部实际共享peer健康才累计恢复', async () => {
  const h = harness()
  try {
    const senders = await adaptiveSharing(h)
    h.peers[0].statsReport = healthReport(40, 0.1)
    h.peers[1].statsReport = healthReport(40, 0)
    await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
    h.peers[0].statsReport = healthReport(40, 0)
    h.peers[1].statsReport = healthReport(40, undefined)
    for (let i = 0; i < 4; i++) await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
    h.peers[1].statsReport = healthReport(40, 0)
    await h.tick(2000); await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
    await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 9100000))
  } finally { h.cleanup() }
})

test('最高明确接收方丢包可降档，即使其他观看成员缺少反馈；候选未知不升档', async () => {
  const h = harness()
  try {
    const senders = await adaptiveSharing(h)
    h.peers[0].statsReport = healthReport(40, undefined)
    h.peers[1].statsReport = healthReport(40, 0.12)
    await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
    h.peers[0].statsReport = healthReport(40, 0)
    h.peers[1].statsReport = healthReport(40, 0)
    h.peers[1].statsReport.delete('transport')
    for (let i = 0; i < 4; i++) await h.tick(2000)
    assert.ok(senders.every(sender => maxBitrate(sender) === 7000000))
  } finally { h.cleanup() }
})

test('同一模块的两个 store 各自拥有媒体与 peer，离开一个房间不会清理另一个实例', async () => {
  const h = harness()
  try {
    const firstMic = await h.join('room-a')
    await h.store.createOffer('z-peer')
    const firstPeer = h.peers.at(-1)
    const second = h.newStore()
    const joining = second.joinRoom('room-b'); await settle()
    const secondMic = h.stream('audio', 'second-mic'); h.mediaRequests.at(-1).resolve(secondMic); await joining
    await second.createOffer('z-peer')
    const secondPeer = h.peers.at(-1), remote = h.remoteAudio(secondPeer, 'second-remote')
    const sharing = second.startScreenShare(), screen = h.stream('video', 'second-screen')
    h.displayRequests.at(-1).resolve(screen); await sharing
    h.store.leaveRoom()
    firstPeer.connectionState = 'failed'; firstPeer.onconnectionstatechange()
    assert.equal(firstMic.getAudioTracks()[0].stopped, true)
    assert.equal(second.currentRoom, 'room-b')
    assert.equal(secondMic.getAudioTracks()[0].readyState, 'live')
    assert.equal(second.screenStream, screen)
    assert.equal(second.isScreenSharing, true)
    assert.equal(second.peerConnections.get('z-peer'), secondPeer)
    assert.equal(secondPeer.closed, undefined)
    assert.equal(remote.element.removed, undefined)
    assert.equal(screen.getVideoTracks()[0].readyState, 'live')
    assert.equal(h.store.peerConnections.size, 0)
  } finally { h.cleanup() }
})

test('旧 peer 已排队的重连回调不能删除同成员新 peer 的重试所有权', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const oldPeer = h.peers.at(-1)
    oldPeer.connectionState = 'failed'; oldPeer.onconnectionstatechange()
    const oldTimer = [...h.timers.values()].find(timer => !timer.interval && timer.delay === 2000)
    assert.ok(oldTimer)
    h.store.cleanupPeer('z-peer'); await h.store.createOffer('z-peer')
    const newestPeer = h.peers.at(-1)
    newestPeer.connectionState = 'failed'; newestPeer.onconnectionstatechange()
    await oldTimer.fn()
    newestPeer.onconnectionstatechange()
    assert.equal([...h.timers.values()].filter(timer => !timer.interval && timer.delay === 2000).length, 1)
    assert.equal([...h.timers.values()].some(timer => !timer.interval && timer.delay === 4000), false)
    assert.equal(h.store.peerConnections.get('z-peer'), newestPeer)
    assert.equal(newestPeer.closed, undefined)
  } finally { h.cleanup() }
})

test('同房间重建 peer 时旧 remoteDescription 不能消耗新连接的 ICE 候选', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const oldPeer = h.peers.at(-1), block = h.blockDescription(oldPeer)
    h.store.handleSignal({ type: 'voice-answer', roomId: 'room-a', userId: 'z-peer', data: { type: 'answer', sdp: 'old-answer' } })
    h.store.cleanupPeer('z-peer'); await h.store.createOffer('z-peer')
    const newestPeer = h.peers.at(-1)
    h.store.handleSignal({ type: 'voice-ice-candidate', roomId: 'room-a', userId: 'z-peer', data: { candidate: 'new-candidate' } })
    block.resolve(); await settle()
    assert.equal(newestPeer.iceCount || 0, 0)
    h.store.handleSignal({ type: 'voice-answer', roomId: 'room-a', userId: 'z-peer', data: { type: 'answer', sdp: 'new-answer' } })
    await settle()
    assert.equal(oldPeer.iceCount || 0, 0)
    assert.equal(newestPeer.iceCount, 1)
    assert.equal(newestPeer.iceCandidates[0].candidate, 'new-candidate')
    assert.equal(h.store.peerConnections.get('z-peer'), newestPeer)
  } finally { h.cleanup() }
})

test('跨房期间等待中的 answer 与 ICE flush 不发送旧答复或继续向旧连接补候选', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const oldPeer = h.peers.at(-1), ice = h.blockIce(oldPeer)
    for (const candidate of ['first', 'second']) h.store.handleSignal({ type: 'voice-ice-candidate', roomId: 'room-a', userId: 'z-peer', data: { candidate } })
    h.store.handleSignal({ type: 'voice-offer', roomId: 'room-a', userId: 'z-peer', data: { type: 'offer', sdp: 'remote' } })
    await settle(); assert.equal(oldPeer.iceCount, 1)
    await h.join('room-b'); await h.store.createOffer('z-peer')
    const newestPeer = h.peers.at(-1)
    ice.resolve(); await settle()
    assert.equal(oldPeer.iceCount, 1)
    assert.equal(oldPeer.answers || 0, 0)
    assert.equal(newestPeer.iceCount || 0, 0)
    assert.equal(h.sent.some(event => event.type === 'voice-answer' && event.roomId === 'room-a'), false)
    const answer = h.blockAnswer(newestPeer)
    h.store.handleSignal({ type: 'voice-offer', roomId: 'room-b', userId: 'z-peer', data: { type: 'offer', sdp: 'remote-b' } })
    await settle(); assert.equal(newestPeer.answers, 1)
    h.storage.set('token', 'token-b'); h.auth.user = { id: 'b-user' }
    answer.resolve(); await settle()
    assert.equal(h.sent.some(event => event.type === 'voice-answer'), false)
    assert.equal(h.store.peerConnections.size, 0)
    assert.equal(h.store.currentRoom, null)
  } finally { h.cleanup() }
})

test('投屏 applyConstraints 迟到不会停止换房后新分享或覆盖其源尺寸', async () => {
  const h = harness()
  try {
    await h.join()
    const oldStream = h.stream('video', 'old-screen'), oldTrack = oldStream.getVideoTracks()[0]
    const blocked = h.blockConstraints(oldTrack)
    const oldSharing = h.store.startScreenShare({ width: 1920, fps: 60 })
    h.displayRequests.at(-1).resolve(oldStream); await settle()
    await h.join('room-b')
    const newest = h.stream('video', 'new-screen')
    newest.getVideoTracks()[0].getSettings = () => ({ width: 1280, height: 720, frameRate: 30 })
    const sharing = h.store.startScreenShare({ width: 1280, fps: 30 })
    h.displayRequests.at(-1).resolve(newest); await sharing
    blocked.resolve(); await oldSharing
    assert.equal(h.store.screenStream, newest)
    assert.equal(h.store.isScreenSharing, true)
    assert.equal(newest.getVideoTracks()[0].readyState, 'live')
    assert.equal(oldTrack.stopped, true)
    assert.equal(h.store.sourceResolution.width, 1280)
    assert.equal(h.sent.filter(event => event.type === 'screen-share-start').length, 1)
    assert.equal(h.sent.find(event => event.type === 'screen-share-start').roomId, 'room-b')
  } finally { h.cleanup() }
})

test('连续更换投屏来源时旧 replaceTrack 晚完成不能恢复旧来源或其已停止轨', async () => {
  const h = harness()
  try {
    const [sender] = await adaptiveSharing(h, ['z-peer'])
    const firstBlock = h.blockReplace(sender), firstStream = h.stream('video', 'first-choice')
    const first = h.store.switchScreenSource(); h.displayRequests.at(-1).resolve(firstStream); await settle()
    assert.ok(sender.replacements.some(item => item.track === firstStream.getVideoTracks()[0]))
    const secondBlock = h.blockReplace(sender), newestStream = h.stream('video', 'latest-choice')
    const second = h.store.switchScreenSource(); h.displayRequests.at(-1).resolve(newestStream); await settle()
    secondBlock.resolve(); await settle()
    firstBlock.resolve(); await first; await second
    assert.equal(h.store.screenStream, newestStream)
    assert.equal(sender.track, newestStream.getVideoTracks()[0])
    assert.equal(sender.track.readyState, 'live')
    assert.equal(sender.track.enabled, true)
    assert.equal(firstStream.getVideoTracks()[0].stopped, true)
    assert.equal(h.store.currentRoom, 'room-a')
  } finally { h.cleanup() }
})

test('旧投屏源在选择器打开时结束，取消选择后必须结束分享而不是保留已停止轨', async () => {
  const h = harness()
  try {
    const [sender] = await adaptiveSharing(h, ['z-peer'])
    const oldTrack = h.store.screenStream.getVideoTracks()[0]
    const switching = h.store.switchScreenSource()
    oldTrack.stop(); oldTrack.onended()
    h.displayRequests.at(-1).reject(new Error('user cancelled')); await switching; await settle()
    assert.equal(h.store.isScreenSharing, false)
    assert.equal(h.store.screenStream, null)
    assert.equal(sender.track, null)
    assert.equal(h.store.currentRoom, 'room-a')
    assert.equal(h.store.localStream.getAudioTracks()[0].readyState, 'live')
    assert.equal(h.sent.filter(event => event.type === 'screen-share-stop').length, 1)
  } finally { h.cleanup() }
})

test('切源已替换一个观看者后被新选择器取消失效，所有观看者回滚到原活轨', async () => {
  const h = harness()
  try {
    const senders = await adaptiveSharing(h)
    const original = h.store.screenStream, originalTrack = original.getVideoTracks()[0]
    const blocked = h.blockReplace(senders[1]), candidate = h.stream('video', 'obsolete-choice')
    const switching = h.store.switchScreenSource(); h.displayRequests.at(-1).resolve(candidate); await settle()
    assert.equal(senders[0].track, candidate.getVideoTracks()[0])
    assert.ok(senders[1].replacements.some(item => item.track === candidate.getVideoTracks()[0]))
    const cancelled = h.store.switchScreenSource()
    h.displayRequests.at(-1).reject(new Error('user cancelled')); await cancelled
    blocked.resolve(); await switching; await settle()
    assert.equal(h.store.screenStream, original)
    assert.equal(h.store.isScreenSharing, true)
    assert.equal(originalTrack.readyState, 'live')
    assert.ok(senders.every(sender => sender.track === originalTrack))
    assert.equal(candidate.getVideoTracks()[0].stopped, true)
    assert.equal(h.sent.some(event => event.type === 'screen-share-stop'), false)
  } finally { h.cleanup() }
})

test('停止分享发生在 replaceTrack 等待期间，晚完成后最终解除视频 sender 且语音保持', async () => {
  const h = harness()
  try {
    const [sender] = await adaptiveSharing(h, ['z-peer'])
    const originalTrack = h.store.screenStream.getVideoTracks()[0], peer = h.peers.at(-1)
    const blocked = h.blockReplace(sender), candidate = h.stream('video', 'cancelled-choice')
    const switching = h.store.switchScreenSource(); h.displayRequests.at(-1).resolve(candidate); await settle()
    assert.ok(sender.replacements.some(item => item.track === candidate.getVideoTracks()[0]))
    h.store.stopScreenShare()
    assert.equal(h.store.isScreenSharing, false)
    assert.equal(h.store.screenStream, null)
    blocked.resolve(); await switching; await settle()
    assert.equal(sender.track, null)
    assert.equal(candidate.getVideoTracks()[0].stopped, true)
    assert.equal(originalTrack.stopped, true)
    assert.equal(h.store.currentRoom, 'room-a')
    assert.equal(h.store.localStream.getAudioTracks()[0].readyState, 'live')
    assert.equal(h.store.peerConnections.get('z-peer'), peer)
    assert.equal(peer.closed, undefined)
    assert.equal(h.sent.filter(event => event.type === 'screen-share-stop').length, 1)
  } finally { h.cleanup() }
})

test('语音重连保留当前投屏源，随后源结束仍立即停止分享并保留重连后的语音', async () => {
  const h = harness()
  try {
    await adaptiveSharing(h, ['z-peer'])
    const screen = h.store.screenStream, track = screen.getVideoTracks()[0], mic = h.store.localStream
    await h.store.rejoinRoom('room-a')
    assert.equal(h.store.screenStream, screen)
    assert.equal(h.store.isScreenSharing, true)
    assert.equal(track.readyState, 'live')
    await h.store.createOffer('z-peer')
    const newestPeer = h.peers.at(-1), sender = newestPeer.getSenders().find(item => item.track === track)
    assert.ok(sender)
    track.stop(); track.onended()
    assert.equal(h.store.isScreenSharing, false)
    assert.equal(h.store.screenStream, null)
    await settle()
    assert.equal(sender.track, null)
    assert.equal(h.store.currentRoom, 'room-a')
    assert.equal(h.store.localStream, mic)
    assert.equal(mic.getAudioTracks()[0].readyState, 'live')
    assert.equal(h.store.peerConnections.get('z-peer'), newestPeer)
    assert.equal(h.sent.filter(event => event.type === 'screen-share-stop').length, 1)
  } finally { h.cleanup() }
})

test('连续切换麦克风时发送器串行替换，最终只发送最新设备且PTT仍需重新按下', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    h.store.setVoiceMode('push-to-talk'); h.store.setPushToTalkPressed(true)
    const sender = h.peers[0].getSenders()[0], blocked = h.blockReplace(sender)
    const first = h.store.changeInputDevice('mic-b')
    const firstRaw = h.stream('audio', 'mic-b'); h.mediaRequests.at(-1).resolve(firstRaw); await settle()
    const firstProcessed = h.processed.at(-1)
    const second = h.store.changeInputDevice('mic-c')
    const secondRaw = h.stream('audio', 'mic-c'); h.mediaRequests.at(-1).resolve(secondRaw); await settle()
    const newest = h.processed.at(-1)
    assert.notEqual(newest, firstProcessed)
    assert.equal(firstRaw.getAudioTracks()[0].stopped, true)
    assert.equal(firstProcessed.stopped, true)
    assert.equal(newest.enabled, false)
    assert.equal(sender.replacements.some(item => item.track === newest), false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.pushToTalkPressed, false)
    blocked.resolve(); await Promise.all([first, second]); await settle()
    assert.equal(sender.track, newest)
    assert.equal(h.store.inputDeviceId, 'mic-c')
    assert.equal(h.store.isTransmitting, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(newest.enabled, true)
    assert.equal(secondRaw.getAudioTracks()[0].enabled, true)
  } finally { h.cleanup() }
})

test('离房立即停止正在替换的麦克风轨，迟到完成不能重新协商或建立发送管线', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const peer = h.peers[0], sender = peer.getSenders()[0], blocked = h.blockReplace(sender)
    const change = h.store.changeInputDevice('mic-b')
    const raw = h.stream('audio', 'pending-mic'); h.mediaRequests.at(-1).resolve(raw); await settle()
    const processed = h.processed.at(-1), offers = h.sent.filter(item => item.type === 'voice-offer').length
    h.store.leaveRoom()
    assert.equal(raw.getAudioTracks()[0].stopped, true)
    assert.equal(processed.stopped, true)
    assert.equal(processed.enabled, false)
    assert.equal(peer.closed, true)
    blocked.resolve(); await change; await settle()
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.store.localStream, null)
    assert.equal(h.store.isTransmitting, false)
    assert.equal(h.sent.filter(item => item.type === 'voice-offer').length, offers)
  } finally { h.cleanup() }
})

test('麦克风在语音重连后仍监听当前设备结束，旧处理轨不会重新开启', async () => {
  const h = harness()
  try {
    const raw = await h.join(), track = raw.getAudioTracks()[0]
    const oldProcessed = h.processed.at(-1)
    h.connect(false); h.connect(true); await h.store.rejoinRoom('room-a')
    assert.equal(h.store.localStream, raw)
    assert.equal(oldProcessed.stopped, true)
    track.readyState = 'ended'; track.listeners.get('ended')()
    assert.equal(h.store.micAvailable, false)
    assert.match(h.store.micError, /已断开/)
    assert.equal(h.store.isTransmitting, false)
    assert.equal(h.processed.at(-1).enabled, false)
    assert.equal(oldProcessed.enabled, false)
  } finally { h.cleanup() }
})

test('移除远端播放元素后不执行排队的输出设备切换，也不复活播放重试', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const remote = h.remoteAudio(), oldUnmute = remote.track.listeners.get('unmute')
    const blocked = h.blockSink('old-output')
    const first = h.store.changeOutputDevice('old-output'); await settle()
    const second = h.store.changeOutputDevice('new-output'); await settle()
    h.store.cleanupPeer('z-peer')
    assert.equal(remote.element.removed, true)
    assert.equal(remote.element.srcObject, null)
    const plays = remote.element.playCount
    oldUnmute(); await h.tick(600)
    assert.equal(remote.element.playCount, plays)
    blocked.resolve(); await Promise.all([first, second]); await settle()
    assert.equal(remote.element.sinkCalls.includes('new-output'), false)
    assert.equal(remote.element.srcObject, null)
    assert.equal(h.store.currentRoom, 'room-a')
  } finally { h.cleanup() }
})

test('两个 store 的统计轮询独立，清理一个实例不影响另一个实例的迟到采样', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const second = h.newStore(), joining = second.joinRoom('room-b'); await settle()
    h.mediaRequests.at(-1).resolve(h.stream('audio', 'second-mic')); await joining; await second.createOffer('z-peer')
    const firstPeer = h.store.peerConnections.get('z-peer'), secondPeer = second.peerConnections.get('z-peer')
    firstPeer.statsDeferred = deferred(); secondPeer.statsDeferred = deferred()
    h.store.setDiagnosticsEnabled(true); second.setDiagnosticsEnabled(true)
    assert.equal(firstPeer.statsCalls, 1)
    assert.equal(secondPeer.statsCalls, 1)
    h.store.leaveRoom()
    firstPeer.statsDeferred.resolve(new Map()); secondPeer.statsDeferred.resolve(new Map()); await settle()
    assert.deepEqual(Object.keys(h.store.peerDiagnostics), [])
    assert.ok(second.peerDiagnostics['z-peer'])
    assert.equal(second.currentRoom, 'room-b')
    await h.tick(2000)
    assert.equal(firstPeer.statsCalls, 1)
    assert.equal(secondPeer.statsCalls, 2)
    assert.equal([...h.timers.values()].filter(timer => timer.interval && timer.delay === 80).length, 1)
  } finally { h.cleanup() }
})

test('当前麦克风结束后换房重新采集，结束设备重连被拒绝时保持仅收听', async () => {
  const h = harness()
  try {
    const first = await h.join(), firstTrack = first.getAudioTracks()[0], firstProcessed = h.processed.at(-1)
    firstTrack.readyState = 'ended'; firstTrack.listeners.get('ended')()
    const changeRoom = h.store.joinRoom('room-b'); await settle()
    assert.equal(h.mediaRequests.length, 2)
    assert.equal(h.store.isTransmitting, false)
    assert.equal(h.store.localStream, null)
    assert.equal(firstProcessed.stopped, true)
    const replacement = h.stream('audio', 'recovered-mic'); h.mediaRequests.at(-1).resolve(replacement); await changeRoom
    assert.equal(h.store.localStream, replacement)
    assert.equal(h.store.micAvailable, true)
    assert.equal(h.store.isTransmitting, true)
    const replacementTrack = replacement.getAudioTracks()[0]
    replacementTrack.readyState = 'ended'; replacementTrack.listeners.get('ended')()
    h.connect(false); h.connect(true)
    const rejoin = h.store.rejoinRoom('room-b'); await settle()
    assert.equal(h.mediaRequests.length, 3)
    h.mediaRequests.at(-1).reject({ name: 'NotAllowedError' }); await rejoin
    assert.equal(h.store.currentRoom, 'room-b')
    assert.equal(h.store.micAvailable, false)
    assert.equal(h.store.localStream, null)
    assert.equal(h.store.isTransmitting, false)
    assert.match(h.store.micError, /权限被拒绝/)
  } finally { h.cleanup() }
})

test('旧房间已经排队的统计与电平回调不能采样新连接或修改新房间状态', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const oldStats = [...h.timers.values()].find(timer => timer.interval && timer.delay === 2000).fn
    const oldLevel = [...h.timers.values()].find(timer => timer.interval && timer.delay === 80).fn
    h.store.leaveRoom(); await h.join('room-b'); await h.store.createOffer('z-peer')
    const peer = h.store.peerConnections.get('z-peer')
    h.store.inputLevel = 0.8; h.store.outputLevel = 0.6
    await oldStats(); oldLevel(); await settle()
    assert.equal(peer.statsCalls || 0, 0)
    assert.equal(h.store.inputLevel, 0.8)
    assert.equal(h.store.outputLevel, 0.6)
    await h.tick(2000); await h.tick(80)
    assert.equal(peer.statsCalls, 1)
    assert.ok(h.store.inputLevel < 0.8)
    assert.ok(h.store.outputLevel < 0.6)
  } finally { h.cleanup() }
})

test('投屏采集已返回而 applyConstraints 未完成时，离房即时停止未安装采集轨', async () => {
  const h = harness()
  try {
    await h.join()
    const capture = h.stream('video', 'pending-capture'), track = capture.getVideoTracks()[0]
    const blocked = h.blockConstraints(track), sharing = h.store.startScreenShare()
    h.displayRequests.at(-1).resolve(capture); await settle()
    assert.equal(track.constraints.length, 1)
    assert.equal(track.readyState, 'live')
    assert.equal(h.store.screenStream, null)
    h.store.leaveRoom()
    assert.equal(track.stopped, true)
    assert.equal(track.enabled, false)
    assert.equal(h.store.currentRoom, null)
    assert.equal(h.store.screenStream, null)
    blocked.resolve(); await sharing
    assert.equal(h.store.isScreenSharing, false)
    assert.equal(h.store.localStream, null)
    assert.equal(h.sent.some(event => event.type === 'screen-share-start'), false)
    assert.equal(h.store.peerConnections.size, 0)
  } finally { h.cleanup() }
})

test('本地提示音在输出切换等待时被耳聋清理，排队选择不能恢复已停止的音效', async () => {
  const h = harness()
  try {
    await h.join()
    h.store.playTestSound(1); await settle()
    const element = h.elements.at(-1), stream = element.srcObject, context = h.contexts.at(-1)
    const blocked = h.blockSink('old-output')
    const first = h.store.changeOutputDevice('old-output'); await settle()
    const second = h.store.changeOutputDevice('new-output'); await settle()
    h.store.toggleDeafen()
    assert.equal(element.srcObject, null)
    assert.equal(element.paused, true)
    assert.equal(stream.getAudioTracks()[0].stopped, true)
    assert.equal(context.state, 'closed')
    const plays = element.playCount
    blocked.resolve(); await Promise.all([first, second]); await h.tick(400)
    assert.equal(element.sinkCalls.includes('new-output'), false)
    assert.equal(element.playCount, plays)
    assert.equal(element.srcObject, null)
    assert.equal(h.store.isDeafened, true)
    assert.equal(h.store.currentRoom, 'room-a')
  } finally { h.cleanup() }
})

test('播放 Promise 在换轨或离房后拒绝，不会给旧音频元素安装重试', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const old = h.remoteAudio()
    old.element.playDeferred = deferred()
    old.track.listeners.get('unmute')()
    const oldPlays = old.element.playCount
    const latest = h.remoteAudio(h.peers.at(-1), 'latest-remote')
    old.element.playDeferred.reject(new Error('late autoplay rejection')); await settle()
    assert.equal([...h.timers.values()].some(timer => !timer.interval && timer.delay === 1000), false)
    assert.equal(old.element.removed, true)
    assert.equal(old.element.srcObject, null)
    assert.equal(old.element.playCount, oldPlays)
    assert.equal(latest.element.srcObject.getAudioTracks()[0], latest.track)
    latest.element.playDeferred = deferred()
    latest.track.listeners.get('unmute')()
    const latestPlays = latest.element.playCount
    h.store.leaveRoom()
    latest.element.playDeferred.reject(new Error('rejected after leave')); await settle(); await h.tick(1000)
    assert.equal(h.timers.size, 0)
    assert.equal(latest.element.removed, true)
    assert.equal(latest.element.srcObject, null)
    assert.equal(latest.element.playCount, latestPlays)
    assert.equal(h.store.currentRoom, null)
  } finally { h.cleanup() }
})

test('多个 store 的远端播放与本地提示音独立，清理一个实例不关闭另一个的输出资源', async () => {
  const h = harness()
  try {
    await h.join(); await h.store.createOffer('z-peer')
    const firstRemote = h.remoteAudio(), firstOutputContext = h.contexts.at(-1)
    h.store.playTestSound(1)
    const firstTone = h.elements.at(-1), firstToneStream = firstTone.srcObject, firstToneContext = h.contexts.at(-1)
    const second = h.newStore(), joining = second.joinRoom('room-b'); await settle()
    h.mediaRequests.at(-1).resolve(h.stream('audio', 'second-mic')); await joining; await second.createOffer('z-peer')
    const secondRemote = h.remoteAudio(h.peers.at(-1), 'second-remote'), secondOutputContext = h.contexts.at(-1)
    second.playTestSound(1)
    const secondTone = h.elements.at(-1), secondToneStream = secondTone.srcObject, secondToneContext = h.contexts.at(-1)
    await settle()
    h.store.leaveRoom()
    assert.equal(firstRemote.element.removed, true)
    assert.equal(firstOutputContext.state, 'closed')
    assert.equal(firstTone.srcObject, null)
    assert.equal(firstToneStream.getAudioTracks()[0].stopped, true)
    assert.equal(firstToneContext.state, 'closed')
    assert.equal(secondRemote.element.removed, undefined)
    assert.equal(secondRemote.element.srcObject.getAudioTracks()[0], secondRemote.track)
    assert.equal(secondOutputContext.state, 'running')
    assert.equal(secondTone.srcObject, secondToneStream)
    assert.equal(secondToneStream.getAudioTracks()[0].readyState, 'live')
    assert.equal(secondToneContext.state, 'running')
    const firstRemoteSinks = firstRemote.element.sinkCalls.length
    await second.changeOutputDevice('second-headset')
    assert.equal(secondRemote.element.sink, 'second-headset')
    assert.equal(secondTone.sink, 'second-headset')
    assert.equal(firstRemote.element.sinkCalls.length, firstRemoteSinks)
    assert.equal(second.currentRoom, 'room-b')
  } finally { h.cleanup() }
})

test('首次入房没有麦克风时保留接收连接，重试成功复用同一个音频 transceiver 恢复发送', async () => {
  const h = harness()
  try {
    const joining = h.store.joinRoom('room-a'); await settle()
    const permissionError = new Error('microphone denied'); permissionError.name = 'NotAllowedError'
    h.mediaRequests.at(-1).reject(permissionError); await joining
    await h.store.createOffer('z-peer')
    const peer = h.peers.at(-1), transceiver = peer.getTransceivers().find(item => item.receiver.track.kind === 'audio')
    assert.equal(h.store.localStream, null)
    assert.equal(h.store.micAvailable, false)
    assert.equal(transceiver.direction, 'recvonly')
    assert.equal(peer.getSenders().length, 0)
    const retry = h.store.retryMic(), raw = h.stream('audio', 'recovered-mic')
    h.mediaRequests.at(-1).resolve(raw); await retry
    assert.equal(peer.getTransceivers().find(item => item.receiver.track.kind === 'audio'), transceiver)
    assert.equal(peer.getTransceivers().filter(item => item.receiver.track.kind === 'audio').length, 1)
    assert.equal(transceiver.direction, 'sendrecv')
    assert.equal(transceiver.sender.track, h.processed.at(-1))
    assert.equal(transceiver.sender.track.readyState, 'live')
    assert.equal(h.store.localStream, raw)
    assert.equal(h.store.micAvailable, true)
    assert.equal(h.store.isTransmitting, true)
  } finally { h.cleanup() }
})

test('恢复麦克风的替换尚未完成时新设备采集失败，保留活轨并完成接收连接的发送恢复', async () => {
  const h = harness()
  try {
    const joining = h.store.joinRoom('room-a'); await settle()
    h.mediaRequests.at(-1).reject(new Error('no microphone')); await joining
    await h.store.createOffer('z-peer')
    const peer = h.peers.at(-1), transceiver = peer.getTransceivers().find(item => item.receiver.track.kind === 'audio')
    h.store.setVoiceMode('push-to-talk')
    const blocked = h.blockReplace(transceiver.sender), retry = h.store.retryMic()
    const raw = h.stream('audio', 'working-mic'); h.mediaRequests.at(-1).resolve(raw); await settle()
    const processed = h.processed.at(-1)
    assert.equal(transceiver.direction, 'recvonly')
    assert.ok(transceiver.sender.replacements.some(item => item.track === processed))
    const failedSwitch = h.store.changeInputDevice('missing-mic')
    h.mediaRequests.at(-1).reject(new Error('selected microphone missing')); await settle()
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(raw.getAudioTracks()[0].readyState, 'live')
    assert.equal(raw.getAudioTracks()[0].enabled, false)
    blocked.resolve(); await Promise.all([retry, failedSwitch]); await settle()
    assert.equal(h.store.localStream, raw)
    assert.equal(h.store.micAvailable, true)
    assert.equal(transceiver.direction, 'sendrecv')
    assert.equal(transceiver.sender.track, processed)
    assert.equal(processed.readyState, 'live')
    assert.equal(processed.enabled, false)
    assert.equal(h.store.pushToTalkPressed, false)
    assert.equal(h.store.isTransmitting, false)
    h.store.setPushToTalkPressed(true)
    assert.equal(h.store.isTransmitting, true)
    assert.equal(processed.enabled, true)
    assert.equal(raw.getAudioTracks()[0].enabled, true)
  } finally { h.cleanup() }
})
