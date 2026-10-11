export type ScreenPlaybackStatus = 'waiting' | 'loading' | 'playing' | 'paused' | 'blocked' | 'stalled' | 'ended' | 'error'

export interface ScreenPlaybackReport {
  status: ScreenPlaybackStatus | string
  paused: boolean
  width: number
  height: number
  fps: number | null
  framesPresented: number | null
  currentTime?: number | null
}

export interface ScreenPlaybackDiagnostics {
  status: ScreenPlaybackStatus | null
  paused: boolean | null
  width: number | null
  height: number | null
  fps: number | null
  framesPresented: number | null
  currentTime: number | null
  updatedAt: number
}

export interface MediaDiagnostics {
  bytes: number | null
  bitrateKbps: number | null
  packets: number | null
  packetsLost: number | null
  lossPercent: number | null
  framesReceived: number | null
  framesDecoded: number | null
  framesSent: number | null
  framesDropped: number | null
  fps: number | null
  width: number | null
  height: number | null
}

export interface PeerDiagnostics {
  userId: string
  connectionState: string | null
  iceConnectionState: string | null
  sampledAt: number | null
  error: string | null
  rttMs: number | null
  selectedCandidate: { localType: string | null; remoteType: string | null; protocol: string | null }
  audioIn: MediaDiagnostics
  audioOut: MediaDiagnostics
  videoIn: MediaDiagnostics
  videoOut: MediaDiagnostics
  playback: ScreenPlaybackDiagnostics | null
}

interface MediaBaseline {
  id: string | null
  timestamp: number | null
  bytes: number | null
  frames: number | null
}

export interface PeerStatsBaseline {
  audioIn: MediaBaseline
  audioOut: MediaBaseline
  videoIn: MediaBaseline
  videoOut: MediaBaseline
}

type StatsConnection = Pick<RTCPeerConnection, 'connectionState' | 'iceConnectionState'> &
  Partial<Pick<RTCPeerConnection, 'getSenders' | 'getReceivers'>>

export interface ScreenSenderHealth {
  rttMs: number | null
  lossPercent: number | null
}

export function diagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function dimension(value: unknown): number | null {
  const number = diagnosticNumber(value)
  return number !== null && number > 0 ? number : null
}

function enumValue(value: unknown, allowed: string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null
}

export function normalizePlaybackReport(value: ScreenPlaybackReport, now = Date.now()): ScreenPlaybackDiagnostics {
  return {
    status: enumValue(value.status, ['waiting', 'loading', 'playing', 'paused', 'blocked', 'stalled', 'ended', 'error']) as ScreenPlaybackStatus | null,
    paused: typeof value.paused === 'boolean' ? value.paused : null,
    width: dimension(value.width), height: dimension(value.height), fps: diagnosticNumber(value.fps),
    framesPresented: diagnosticNumber(value.framesPresented), currentTime: diagnosticNumber(value.currentTime), updatedAt: now
  }
}

function emptyMedia(): MediaDiagnostics {
  return { bytes: null, bitrateKbps: null, packets: null, packetsLost: null, lossPercent: null,
    framesReceived: null, framesDecoded: null, framesSent: null, framesDropped: null, fps: null, width: null, height: null }
}

export function emptyPeerDiagnostics(userId: string, pc: Pick<RTCPeerConnection, 'connectionState' | 'iceConnectionState'>,
  playback: ScreenPlaybackDiagnostics | null = null): PeerDiagnostics {
  return {
    userId,
    connectionState: enumValue(pc.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
    iceConnectionState: enumValue(pc.iceConnectionState, ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']),
    sampledAt: null, error: null, rttMs: null, selectedCandidate: { localType: null, remoteType: null, protocol: null },
    audioIn: emptyMedia(), audioOut: emptyMedia(), videoIn: emptyMedia(), videoOut: emptyMedia(), playback
  }
}

function difference(current: number | null, previous: number | null, elapsedMs: number | null): number | null {
  return current !== null && previous !== null && elapsedMs !== null && elapsedMs > 0 && current >= previous
    ? (current - previous) * 1000 / elapsedMs : null
}

function readMedia(stat: any, remote: any, outgoing: boolean, previous?: MediaBaseline): { media: MediaDiagnostics; baseline: MediaBaseline } {
  const media = emptyMedia()
  const timestamp = diagnosticNumber(stat?.timestamp)
  const id = typeof stat?.id === 'string' ? stat.id : null
  const same = id !== null && id === previous?.id
  const elapsed = same && timestamp !== null && previous?.timestamp !== null && previous?.timestamp !== undefined
    ? timestamp - previous.timestamp : null
  const bytes = diagnosticNumber(outgoing ? stat?.bytesSent : stat?.bytesReceived)
  const frames = diagnosticNumber(outgoing ? stat?.framesSent : stat?.framesDecoded)
  media.bytes = bytes
  const byteRate = difference(bytes, same ? previous?.bytes ?? null : null, elapsed)
  media.bitrateKbps = byteRate === null ? null : byteRate * 8 / 1000
  media.packets = diagnosticNumber(outgoing ? stat?.packetsSent : stat?.packetsReceived)
  media.packetsLost = diagnosticNumber(outgoing ? remote?.packetsLost : stat?.packetsLost)
  const received = diagnosticNumber(outgoing ? remote?.packetsReceived : stat?.packetsReceived)
  const denominator = received !== null && media.packetsLost !== null ? received + media.packetsLost : outgoing ? media.packets : null
  media.lossPercent = media.packetsLost !== null && denominator !== null && denominator > 0
    ? Math.min(100, media.packetsLost / denominator * 100) : null
  // A present 0% is valid only when the browser supplied both counters.
  if (denominator === 0 && media.packetsLost === 0) media.lossPercent = 0
  media.framesReceived = diagnosticNumber(stat?.framesReceived)
  media.framesDecoded = diagnosticNumber(stat?.framesDecoded)
  media.framesSent = diagnosticNumber(stat?.framesSent)
  media.framesDropped = diagnosticNumber(stat?.framesDropped)
  media.fps = diagnosticNumber(stat?.framesPerSecond) ?? difference(frames, same ? previous?.frames ?? null : null, elapsed)
  media.width = dimension(stat?.frameWidth)
  media.height = dimension(stat?.frameHeight)
  return { media, baseline: { id, timestamp, bytes, frames } }
}

function reportRows(report: { forEach(callback: (value: any) => void): void }) {
  const rows: any[] = []
  report.forEach(value => { if (value && typeof value === 'object') rows.push(value) })
  const byId = new Map(rows.filter(row => typeof row.id === 'string').map(row => [row.id, row]))
  return { rows, byId }
}

function selectedPair(rows: any[], byId: Map<string, any>, transportId?: string) {
  if (transportId) {
    const transport = byId.get(transportId)
    const pair = transport?.type === 'transport' && byId.get(transport.selectedCandidatePairId)
    return pair?.type === 'candidate-pair' ? pair : null
  }
  const explicit = transportId && byId.get(transportId)
  const transports = explicit?.type === 'transport' ? [explicit] : rows.filter(row => row.type === 'transport')
  const fromTransport = transports.map(row => byId.get(row.selectedCandidatePairId)).find(row => row?.type === 'candidate-pair')
  const selected = rows.filter(row => row.type === 'candidate-pair' && row.selected === true)
  const nominated = rows.filter(row => row.type === 'candidate-pair' && row.nominated === true && row.state === 'succeeded')
  // A merely succeeded or low-RTT candidate is not proof that it was selected.
  return fromTransport || (selected.length === 1 ? selected[0] : nominated.length === 1 ? nominated[0] : null)
}

function liveTrackIds(pc: StatsConnection, kind: 'audio' | 'video', outgoing: boolean): Set<string> | null {
  try {
    const getter = outgoing ? pc.getSenders : pc.getReceivers
    if (typeof getter !== 'function') return null
    const endpoints: (RTCRtpSender | RTCRtpReceiver)[] = outgoing ? pc.getSenders!() : pc.getReceivers!()
    return new Set(endpoints.map(endpoint => endpoint.track)
      .filter(track => track?.kind === kind && track.readyState !== 'ended' && typeof track.id === 'string' && track.id.length > 0)
      .map(track => track!.id))
  } catch { return null }
}

function rtpTrackId(row: any, byId: Map<string, any>): string | null {
  const id = row.trackIdentifier ?? byId.get(row.mediaSourceId)?.trackIdentifier ?? byId.get(row.trackId)?.trackIdentifier
  return typeof id === 'string' && id.length > 0 ? id : null
}

function mediaRow(rows: any[], byId: Map<string, any>, kind: 'audio' | 'video', outgoing: boolean, tracks: Set<string> | null) {
  const type = outgoing ? 'outbound-rtp' : 'inbound-rtp'
  let candidates = rows.filter(row => row.type === type && row.isRemote !== true && row.active !== false &&
    (row.kind ?? row.mediaType) === kind && !/\/(?:rtx|red|ulpfec|flexfec)/i.test(String(byId.get(row.codecId)?.mimeType || '')))
  if (tracks !== null) {
    if (tracks.size === 0) return undefined
    const matched = candidates.filter(row => { const id = rtpTrackId(row, byId); return id !== null && tracks.has(id) })
    // Only unidentified records can be a compatibility fallback. A positively
    // identified old track must never override the currently attached track.
    candidates = matched.length ? matched : candidates.filter(row => rtpTrackId(row, byId) === null)
  }
  return candidates.sort((a, b) => Number(b.active === true) - Number(a.active === true) ||
    (diagnosticNumber(b.lastPacketReceivedTimestamp) ?? -1) - (diagnosticNumber(a.lastPacketReceivedTimestamp) ?? -1) ||
    (diagnosticNumber(outgoing ? b.bytesSent : b.bytesReceived) ?? -1) - (diagnosticNumber(outgoing ? a.bytesSent : a.bytesReceived) ?? -1))[0]
}

/** The adaptive sender uses only selected-path RTT and this video's receiver feedback. */
export function extractScreenSenderHealth(report: { forEach(callback: (value: any) => void): void }, trackId: string): ScreenSenderHealth {
  const { rows, byId } = reportRows(report)
  const outbound = mediaRow(rows, byId, 'video', true, new Set([trackId]))
  const pair = selectedPair(rows, byId, outbound?.transportId)
  const rtt = diagnosticNumber(pair?.currentRoundTripTime)
  const health: ScreenSenderHealth = { rttMs: rtt === null ? null : rtt * 1000, lossPercent: null }
  const remote = outbound && byId.get(outbound.remoteId)
  if (remote?.type !== 'remote-inbound-rtp' || (remote.localId && remote.localId !== outbound.id)) return health
  const fraction = diagnosticNumber(remote.fractionLost)
  if (fraction !== null && fraction <= 1) health.lossPercent = fraction * 100
  else health.lossPercent = readMedia(outbound, remote, true).media.lossPercent
  return health
}

/** Parse only the public diagnostic whitelist. Addresses, SDP and arbitrary errors never enter the result. */
export function extractPeerDiagnostics(userId: string, pc: StatsConnection,
  report: { forEach(callback: (value: any) => void): void }, previous?: PeerStatsBaseline, now = Date.now()) {
  const { rows, byId } = reportRows(report)
  const diagnostics = emptyPeerDiagnostics(userId, pc)
  diagnostics.sampledAt = now
  const pair = selectedPair(rows, byId)
  if (pair) {
    const rtt = diagnosticNumber(pair.currentRoundTripTime)
    diagnostics.rttMs = rtt === null ? null : rtt * 1000
    const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId)
    const types = ['host', 'srflx', 'prflx', 'relay']
    diagnostics.selectedCandidate = {
      localType: enumValue(local?.candidateType, types), remoteType: enumValue(remote?.candidateType, types),
      protocol: enumValue(local?.protocol, ['udp', 'tcp']) ?? enumValue(remote?.protocol, ['udp', 'tcp'])
    }
  }
  const baseline = {} as PeerStatsBaseline
  for (const [key, kind, outgoing] of [
    ['audioIn', 'audio', false], ['audioOut', 'audio', true], ['videoIn', 'video', false], ['videoOut', 'video', true]
  ] as const) {
    const stat = mediaRow(rows, byId, kind, outgoing, liveTrackIds(pc, kind, outgoing))
    const remote = stat && byId.get(stat.remoteId)
    const result = readMedia(stat, remote?.type === 'remote-inbound-rtp' ? remote : null, outgoing, previous?.[key])
    diagnostics[key] = result.media
    baseline[key] = result.baseline
  }
  return { diagnostics, baseline }
}

export function diagnosticValue(value: number | null | undefined, unit = '', digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '未提供' : `${value.toFixed(digits)}${unit}`
}

export function diagnosticState(value: string | null | undefined): string {
  const names: Record<string, string> = {
    new: '准备中', connecting: '连接中', connected: '已连接', disconnected: '已断开', failed: '连接失败', closed: '已关闭',
    checking: '检查中', completed: '已完成', waiting: '等待画面', loading: '加载中', playing: '播放中', paused: '已暂停',
    blocked: '等待手动播放', stalled: '画面停滞', ended: '已结束', error: '播放失败'
  }
  return value && Object.prototype.hasOwnProperty.call(names, value) ? names[value] : '未提供'
}
