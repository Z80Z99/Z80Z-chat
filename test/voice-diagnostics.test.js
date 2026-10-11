import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeerDiagnostics, extractScreenSenderHealth, normalizePlaybackReport, diagnosticValue, diagnosticState } from '../frontend/src/utils/voice-diagnostics.ts'

const pc = { connectionState: 'connected', iceConnectionState: 'completed' }
const report = rows => new Map(rows.map(row => [row.id, row]))
const media = (timestamp = 1000, options = {}) => ({ id: 'video-in', type: 'inbound-rtp', kind: 'video', timestamp,
  bytesReceived: 100000, packetsReceived: 90, packetsLost: 10, framesReceived: 30, framesDecoded: 24, frameWidth: 1280, frameHeight: 720, ...options })

test('使用已选择的ICE通路，不以最小RTT猜测通路；仅输出候选类型和协议', () => {
  const data = extractPeerDiagnostics('peer', pc, report([
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'unused', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.001 },
    { id: 'selected', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.12, localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', address: '192.0.2.20', ip: '192.0.2.20', usernameFragment: 'secret-local' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '203.0.113.11', url: 'turn:secret-token@server' }
  ])).diagnostics
  assert.equal(data.rttMs, 120)
  assert.deepEqual(data.selectedCandidate, { localType: 'relay', remoteType: 'srflx', protocol: 'udp' })
  assert.equal(data.connectionState, 'connected')
  assert.equal(data.iceConnectionState, 'completed')
  const json = JSON.stringify(data)
  for (const secret of ['192.0.2', '203.0.113', 'secret', 'address', 'usernameFragment']) assert.equal(json.includes(secret), false)
})

test('缺失统计保持null；实际提供的0延迟、0帧与0%丢包仍为0', () => {
  const absent = extractPeerDiagnostics('peer', {}, report([])).diagnostics
  assert.equal(absent.rttMs, null)
  assert.equal(absent.videoIn.framesReceived, null)
  assert.equal(absent.videoIn.lossPercent, null)
  assert.equal(absent.videoIn.bitrateKbps, null)
  assert.equal(absent.connectionState, null)
  const zero = extractPeerDiagnostics('peer', pc, report([
    { id: 'selected', type: 'candidate-pair', selected: true, currentRoundTripTime: 0 },
    media(1000, { bytesReceived: 0, packetsReceived: 0, packetsLost: 0, framesReceived: 0, framesDecoded: 0, framesPerSecond: 0 })
  ])).diagnostics
  assert.equal(zero.rttMs, 0)
  assert.equal(zero.videoIn.framesReceived, 0)
  assert.equal(zero.videoIn.fps, 0)
  assert.equal(zero.videoIn.lossPercent, 0)
  assert.equal(diagnosticValue(null, ' ms'), '未提供')
  assert.equal(diagnosticValue(0, ' ms'), '0 ms')
})

test('码率按每个RTP统计自己的timestamp差值计算，首个样本或重置不伪称0', () => {
  const first = extractPeerDiagnostics('peer', pc, report([media()]))
  assert.equal(first.diagnostics.videoIn.bitrateKbps, null)
  const second = extractPeerDiagnostics('peer', pc, report([media(3000, { bytesReceived: 300000, framesDecoded: 84 })]), first.baseline)
  assert.equal(second.diagnostics.videoIn.bitrateKbps, 800)
  assert.equal(second.diagnostics.videoIn.fps, 30)
  assert.equal(second.diagnostics.videoIn.lossPercent, 10)
  const reset = extractPeerDiagnostics('peer', pc, report([media(4000, { bytesReceived: 100, framesDecoded: 3 })]), second.baseline)
  assert.equal(reset.diagnostics.videoIn.bitrateKbps, null)
  assert.equal(reset.diagnostics.videoIn.fps, null)
  const replacement = extractPeerDiagnostics('peer', pc, report([media(5000, { id: 'new-video', bytesReceived: 1000000 })]), second.baseline)
  assert.equal(replacement.diagnostics.videoIn.bitrateKbps, null)
})

test('只把关联remote-inbound丢包归给对应发送流，RTX不覆盖主视频', () => {
  const result = extractPeerDiagnostics('peer', pc, report([
    media(), { id: 'rtx-codec', type: 'codec', mimeType: 'video/rtx' },
    media(1000, { id: 'video-rtx', bytesReceived: 900000, codecId: 'rtx-codec', framesDecoded: 0 }),
    { id: 'audio-out', type: 'outbound-rtp', kind: 'audio', timestamp: 1000, bytesSent: 3000, packetsSent: 100, remoteId: 'audio-report' },
    { id: 'audio-report', type: 'remote-inbound-rtp', kind: 'audio', packetsReceived: 96, packetsLost: 4 },
    { id: 'video-out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 400000, packetsSent: 1000 },
    { id: 'unrelated', type: 'remote-inbound-rtp', packetsLost: 999 }
  ])).diagnostics
  assert.equal(result.videoIn.framesDecoded, 24)
  assert.equal(result.audioOut.lossPercent, 4)
  assert.equal(result.videoOut.lossPercent, null)
})

test('未选择或有歧义的成功通路保持未知，非法指标/状态不进入界面', () => {
  const result = extractPeerDiagnostics('peer', { connectionState: 'token-secret', iceConnectionState: '192.0.2.1' }, report([
    { id: 'a', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.1 },
    { id: 'b', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.2 },
    media(1000, { bytesReceived: NaN, packetsLost: Infinity, framesDecoded: -3 })
  ])).diagnostics
  assert.equal(result.rttMs, null)
  assert.equal(result.connectionState, null)
  assert.equal(result.iceConnectionState, null)
  assert.equal(result.videoIn.bytes, null)
  assert.equal(result.videoIn.framesDecoded, null)
  assert.equal(result.videoIn.lossPercent, null)
  assert.equal(diagnosticState('token-secret'), '未提供')
  assert.equal(diagnosticState('constructor'), '未提供')
})

test('媒体已收到和解码不代表播放器已呈现，播放报告只保存白名单值', () => {
  const data = extractPeerDiagnostics('peer', pc, report([media()])).diagnostics
  assert.equal(data.videoIn.framesReceived, 30)
  assert.equal(data.videoIn.framesDecoded, 24)
  assert.equal(data.playback, null)
  const playback = normalizePlaybackReport({ status: 'blocked', paused: true, width: 0, height: 0, fps: null, framesPresented: null,
    currentTime: NaN, address: 'secret', token: 'hidden', error: '192.0.2.1' }, 1000)
  assert.equal(playback.status, 'blocked')
  assert.equal(playback.framesPresented, null)
  assert.equal(playback.currentTime, null)
  assert.equal(playback.updatedAt, 1000)
  assert.equal(JSON.stringify(playback).includes('secret'), false)
  assert.equal(JSON.stringify(playback).includes('hidden'), false)
})

test('排除明确inactive视频，新receiver/sender轨关联优先于旧累计RTP流量', () => {
  const tracks = { ...pc,
    getReceivers: () => [{ track: { id: 'current-in', kind: 'video', readyState: 'live' } }],
    getSenders: () => [{ track: { id: 'current-out', kind: 'video', readyState: 'live' } }]
  }
  const data = extractPeerDiagnostics('peer', tracks, report([
    media(1000, { id: 'old-in', trackIdentifier: 'old-in', bytesReceived: 90000000, framesDecoded: 9000 }),
    media(1000, { id: 'current-in', trackIdentifier: 'current-in', bytesReceived: 100, framesDecoded: 5 }),
    media(1000, { id: 'inactive-in', active: false, trackIdentifier: 'current-in', bytesReceived: 99999999, framesDecoded: 9999 }),
    { id: 'old-source', type: 'media-source', trackIdentifier: 'old-out' },
    { id: 'current-source', type: 'media-source', trackIdentifier: 'current-out' },
    { id: 'old-out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'old-source', bytesSent: 9000000, framesSent: 999 },
    { id: 'current-out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'current-source', bytesSent: 200, framesSent: 8 },
    { id: 'inactive-out', type: 'outbound-rtp', kind: 'video', active: false, mediaSourceId: 'current-source', bytesSent: 99999999, framesSent: 9999 }
  ])).diagnostics
  assert.equal(data.videoIn.framesDecoded, 5)
  assert.equal(data.videoOut.framesSent, 8)
})

test('已明确旧轨不能fallback，未提供identifier仍可兼容；无getter按active信号排除旧流', () => {
  const tracks = { ...pc, getReceivers: () => [{ track: { id: 'new', kind: 'video', readyState: 'live' } }] }
  assert.equal(extractPeerDiagnostics('peer', tracks, report([media(1000, { trackIdentifier: 'old' })])).diagnostics.videoIn.framesDecoded, null)
  assert.equal(extractPeerDiagnostics('peer', tracks, report([media()])).diagnostics.videoIn.framesDecoded, 24)
  const noGetter = extractPeerDiagnostics('peer', pc, report([
    media(1000, { id: 'old', active: false, bytesReceived: 99999999, framesDecoded: 999 }), media()
  ])).diagnostics
  assert.equal(noGetter.videoIn.framesDecoded, 24)
})

test('投屏健康只用当前sender对应的remote反馈与所选通路，不取未选中低RTT', () => {
  const stats = report([
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'selected', type: 'candidate-pair', currentRoundTripTime: 0.4 },
    { id: 'unused', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.001 },
    { id: 'source', type: 'media-source', trackIdentifier: 'screen' },
    { id: 'out', type: 'outbound-rtp', kind: 'video', transportId: 'transport', mediaSourceId: 'source', remoteId: 'remote', packetsSent: 100 },
    { id: 'remote', type: 'remote-inbound-rtp', localId: 'out', packetsLost: 0, fractionLost: 0.08 },
    { id: 'stale-out', type: 'outbound-rtp', kind: 'video', trackIdentifier: 'previous-screen', remoteId: 'stale-remote', bytesSent: 99999999 },
    { id: 'stale-remote', type: 'remote-inbound-rtp', fractionLost: 0 }
  ])
  const health = extractScreenSenderHealth(stats, 'screen')
  assert.deepEqual(health, { rttMs: 400, lossPercent: 8 })
})

test('投屏remote反馈缺失保持unknown，存在明确零丢包才为0，错配localId无效', () => {
  const base = [
    { id: 'pair', type: 'candidate-pair', selected: true, currentRoundTripTime: 0.04 },
    { id: 'out', type: 'outbound-rtp', kind: 'video', trackIdentifier: 'screen', remoteId: 'remote', packetsSent: 100 }
  ]
  assert.equal(extractScreenSenderHealth(report(base), 'screen').lossPercent, null)
  assert.equal(extractScreenSenderHealth(report([...base, { id: 'remote', type: 'remote-inbound-rtp' }]), 'screen').lossPercent, null)
  assert.equal(extractScreenSenderHealth(report([...base, { id: 'remote', type: 'remote-inbound-rtp', packetsLost: 0 }]), 'screen').lossPercent, 0)
  assert.equal(extractScreenSenderHealth(report([...base, { id: 'remote', type: 'remote-inbound-rtp', localId: 'different', fractionLost: 0 }]), 'screen').lossPercent, null)
})
