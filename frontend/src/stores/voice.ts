import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ws } from '../utils/ws'
import { useAuthStore } from './auth'

export const useVoiceStore = defineStore('voice', () => {
  const authStore = useAuthStore()
  const currentRoom = ref<string | null>(null)
  const participants = ref<string[]>([])
  const voiceRoomMembers = ref<Record<string, string[]>>({})
  const isMuted = ref(false)
  const isDeafened = ref(false)
  const localStream = ref<MediaStream | null>(null)
  const peerConnections = ref<Map<string, RTCPeerConnection>>(new Map())
  // 远程描述未就绪时到达的 ICE candidate 缓存，SRD 完成后统一补加
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  const micAvailable = ref(true)
  const micError = ref('')

  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const inputDeviceId = ref('')
  const outputDeviceId = ref('')
  const inputVolume = ref(1)
  const outputVolume = ref(1)
  const outputSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  let audioCtx: AudioContext | null = null
  let gainNode: GainNode | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let micDest: MediaStreamAudioDestinationNode | null = null
  let sentAudioTrack: MediaStreamTrack | null = null

  const inputLevel = ref(0)
  const outputLevel = ref(0)
  let inputAnalyser: AnalyserNode | null = null
  let levelTimer: any = null
  let outputCtx: AudioContext | null = null
  const outputAnalysers = new Map<string, { src: MediaStreamAudioSourceNode; analyser: AnalyserNode }>()

  const screenStream = ref<MediaStream | null>(null)
  const isScreenSharing = ref(false)
  const screenSenders = ref<Map<string, RTCRtpSender>>(new Map())
  interface RemoteScreenEntry {
    userId: string
    stream: MediaStream
    ts: number
  }
  const remoteScreens = ref<RemoteScreenEntry[]>([])

  let iceServersCache: RTCIceServer[] | null = null
  const fallbackIceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

  async function ensureIceServers() {
    if (iceServersCache) return
    try {
      const res = await fetch('/api/config')
      const cfg = await res.json()
      if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
        iceServersCache = cfg.iceServers
        return
      }
    } catch {}
    iceServersCache = fallbackIceServers
  }

  const connectionStats = ref({
    rtt: 0,
    packetsLost: 0,
    totalPackets: 0,
    lossRate: 0,
    quality: 'unknown' as 'good' | 'fair' | 'poor' | 'unknown',
    cpuCores: navigator.hardwareConcurrency || 0,
    outBitrate: 0,
    outFps: 0,
    outWidth: 0,
    outHeight: 0,
    outLossRate: 0,
    inBitrate: 0,
    inFps: 0,
    inWidth: 0,
    inHeight: 0,
    inLossRate: 0
  })
  let statsTimer: any = null
  let prevBytesOut = 0
  let prevBytesIn = 0
  let prevTs = 0

  const sharePresets: Record<string, { label: string; w: number; h: number }> = {
    '0': { label: '源画质', w: 0, h: 0 },
    '1280': { label: '720p', w: 1280, h: 720 },
    '1920': { label: '1080p', w: 1920, h: 1080 },
    '2560': { label: '2K', w: 2560, h: 1440 },
    '3840': { label: '4K', w: 3840, h: 2160 }
  }
  const currentShareOpts = ref({ width: 1920, fps: 30 })
  const sourceResolution = ref({ width: 0, height: 0 })

  // 投屏码率上限表（bps），按宽度 preset 索引；'0' 为源画质上限
  // 高复杂度画面（全屏游戏/动态场景）需要更高码率，否则编码器被迫掉帧
  const bitrateCeilings: Record<string, number> = {
    '0': 6_000_000,
    '1280': 3_500_000,
    '1920': 6_000_000,
    '2560': 8_000_000,
    '3840': 12_000_000
  }
  const BITRATE_FLOOR = 1_000_000
  // 自适应码率运行时状态
  let bitrateLimit = 0          // 当前生效的码率上限（动态升降）
  let goodQualityStreak = 0     // 连续好质量计数（升档需累积）
  // 投屏源切换标志：切换时旧轨 onended 不应触发 stopScreenShare
  let isSwitching = false

  function bitrateCeilingFor(width: number): number {
    return bitrateCeilings[String(width)] || bitrateCeilings['1920']
  }

  // 将所选画质宽度封顶到源分辨率：返回 ≤ sourceW 的最大 preset；都超则返回 0（源画质）
  function snapPresetToSource(width: number, sourceW: number): number {
    if (width <= 0) return 0
    if (sourceW <= 0) return width
    if (width <= sourceW) return width
    for (const w of [3840, 2560, 1920, 1280]) {
      if (w <= sourceW) return w
    }
    return 0
  }

  async function applySenderBitrate(maxBitrate: number, maxFramerate?: number) {
    for (const sender of screenSenders.value.values()) {
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = maxBitrate
        if (maxFramerate && maxFramerate > 0) params.encodings[0].maxFramerate = maxFramerate
        await sender.setParameters(params)
      } catch {}
    }
  }

  async function ensureMic() {
    if (localStream.value) return true
    micAvailable.value = true
    micError.value = ''
    try {
      localStream.value = await navigator.mediaDevices.getUserMedia({
        audio: inputDeviceId.value ? { deviceId: { exact: inputDeviceId.value } } : true
      })
      return true
    } catch (e: any) {
      micAvailable.value = false
      if (e.name === 'NotFoundError' || e.message?.includes('Requested device not found') || e.message?.includes('device not found')) {
        micError.value = '未检测到麦克风 — 你可以进入频道听别人说话，但无法发言'
      } else if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        micError.value = '麦克风权限被拒绝 — 你可以听但无法发言，浏览器地址栏左侧可修改权限'
      } else {
        micError.value = '麦克风不可用 — 进入频道后仅能听'
      }
      return false
    }
  }

  function ensureAudioCtx() {
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext()
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
    } catch {}
  }

  function tryResumeContexts() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {})
    }
    if (outputCtx && outputCtx.state === 'suspended') {
      outputCtx.resume().catch(() => {})
    }
  }

  if (typeof window !== 'undefined') {
    ['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
      window.addEventListener(evt, () => tryResumeContexts(), { passive: true })
    })
  }

  function initAudioPipeline() {
    try {
      if (!localStream.value) return
      destroyAudioPipeline()
      ensureAudioCtx()
      if (!audioCtx) return
      gainNode = audioCtx.createGain()
      gainNode.gain.value = inputVolume.value
      micDest = audioCtx.createMediaStreamDestination()
      inputAnalyser = audioCtx.createAnalyser()
      inputAnalyser.fftSize = 512
      micSource = audioCtx.createMediaStreamSource(localStream.value)
      micSource.connect(gainNode)
      gainNode.connect(inputAnalyser)
      inputAnalyser.connect(micDest)
      sentAudioTrack = micDest.stream.getAudioTracks()[0] || null
      if (sentAudioTrack) {
        peerConnections.value.forEach((pc) => {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio')
          sender?.replaceTrack(sentAudioTrack)
        })
      }
    } catch (e) {
      console.error('音频处理管线初始化失败', e)
      micAvailable.value = false
      micError.value = '音频处理不可用，仅能听'
    }
  }

  function destroyAudioPipeline() {
    micSource?.disconnect()
    gainNode?.disconnect()
    inputAnalyser?.disconnect()
    audioCtx?.close().catch(() => {})
    micSource = null
    gainNode = null
    micDest = null
    audioCtx = null
    sentAudioTrack = null
    inputAnalyser = null
  }

  function measureLevel(analyser: AnalyserNode) {
    const buf = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4)
  }

  function startLevelPolling() {
    stopLevelPolling()
    levelTimer = setInterval(() => {
      const targetIn = !isMuted.value && inputAnalyser ? measureLevel(inputAnalyser) : 0
      inputLevel.value = inputLevel.value + (targetIn - inputLevel.value) * 0.35
      let total = 0
      let count = 0
      outputAnalysers.forEach(({ analyser }) => {
        total += measureLevel(analyser)
        count++
      })
      const targetOut = count ? total / count : 0
      outputLevel.value = outputLevel.value + (targetOut - outputLevel.value) * 0.35
    }, 80)
  }

  function stopLevelPolling() {
    if (levelTimer) {
      clearInterval(levelTimer)
      levelTimer = null
    }
  }

  function ensureOutputCtx() {
    if (!outputCtx || outputCtx.state === 'closed') {
      outputCtx = new AudioContext()
      if (outputCtx.state === 'suspended') {
        outputCtx.resume().catch(() => {})
      }
    }
  }

  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      inputDevices.value = all.filter(d => d.kind === 'audioinput')
      outputDevices.value = all.filter(d => d.kind === 'audiooutput')
      if (!inputDevices.value.some(d => d.deviceId === inputDeviceId.value)) {
        inputDeviceId.value = inputDevices.value[0]?.deviceId || ''
      }
      if (!outputDevices.value.some(d => d.deviceId === outputDeviceId.value)) {
        outputDeviceId.value = outputDevices.value[0]?.deviceId || ''
      }
    } catch {}
  }

  async function changeInputDevice(deviceId: string) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      })
      localStream.value?.getTracks().forEach(t => t.stop())
      localStream.value = stream
      inputDeviceId.value = deviceId
      micAvailable.value = true
      micError.value = ''
      initAudioPipeline()
    } catch (e: any) {
      micAvailable.value = false
      micError.value = '无法切换输入设备，已保持原设备'
    }
  }

  async function changeOutputDevice(deviceId: string) {
    outputDeviceId.value = deviceId
    const els = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio-"]')
    for (const el of els) {
      try {
        await (el as any).setSinkId(deviceId)
      } catch {}
    }
  }

  function setInputVolume(v: number) {
    inputVolume.value = v
    if (gainNode && audioCtx) {
      gainNode.gain.setTargetAtTime(v, audioCtx.currentTime, 0.05)
    }
  }

  function setOutputVolume(v: number) {
    outputVolume.value = v
    const audioElements = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio-"]')
    audioElements.forEach(el => {
      if (isDeafened.value) {
        // If deafened, store the volume but keep muted
        el.dataset.originalVolume = v.toString()
      } else {
        el.volume = v
      }
    })
  }

  // 本地音效统一输出：振荡器 → MediaStreamDestination → Audio 元素播放
  // 用 Audio 元素（而非 ctx.destination）是为了跟随账号选择的输出设备（setSinkId），
  // 且不会进入麦克风发送链路（gainNode）。播完自动清理。
  function playLocalTone(freqs: number[], volume = 0.15) {
    try {
      ensureAudioCtx()
      if (!audioCtx) return
      const ctx = audioCtx
      const t0 = ctx.currentTime
      const dest = ctx.createMediaStreamDestination()

      const tones = freqs.map((freq, i) => {
        const start = t0 + i * 0.1
        const duration = 0.12
        const osc = ctx.createOscillator()
        const amp = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        amp.gain.setValueAtTime(0, start)
        amp.gain.linearRampToValueAtTime(volume, start + 0.015)
        amp.gain.setValueAtTime(volume, start + duration - 0.04)
        amp.gain.linearRampToValueAtTime(0, start + duration)
        osc.connect(amp)
        amp.connect(dest)
        osc.start(start)
        osc.stop(start + duration + 0.05)
        return { osc, amp }
      })

      const el = new Audio()
      el.srcObject = dest.stream
      if (outputDeviceId.value) {
        ;(el as any).setSinkId(outputDeviceId.value).catch(() => {})
      }
      el.play().catch(() => {})

      // 播完清理
      setTimeout(() => {
        try { el.pause() } catch {}
        el.srcObject = null
        dest.stream.getTracks().forEach(t => t.stop())
        tones.forEach(({ osc, amp }) => {
          try { osc.disconnect(); amp.disconnect() } catch {}
        })
      }, freqs.length * 100 + 300)
    } catch {}
  }

  // 测试音效发送链路：振荡器 → gain → gainNode（麦克风发送链路）
  // 只发给对方（自己听不到），验证语音发送链路；
  // 静音/耳聋时 micDest 的 track 已 disabled，音效不会泄露给对方。播完自动清理。
  function sendToneToMic(freqs: number[], volume = 0.4) {
    if (!audioCtx || !gainNode) return
    try {
      const ctx = audioCtx
      const t0 = ctx.currentTime
      freqs.forEach((freq, i) => {
        const start = t0 + i * 0.1
        const duration = 0.12
        const osc = ctx.createOscillator()
        const amp = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        amp.gain.setValueAtTime(0, start)
        amp.gain.linearRampToValueAtTime(volume, start + 0.015)
        amp.gain.setValueAtTime(volume, start + duration - 0.04)
        amp.gain.linearRampToValueAtTime(0, start + duration)
        osc.connect(amp)
        amp.connect(gainNode)
        osc.start(start)
        osc.stop(start + duration + 0.05)
        osc.onended = () => {
          try { osc.disconnect(); amp.disconnect() } catch {}
        }
      })
    } catch {}
  }

  function playTestSound(id: number) {
    if (id === 1) {
      sendToneToMic([880], 0.4)
    } else {
      sendToneToMic([440, 660], 0.4)
    }
  }

  // 系统提示音：有人进出语音频道 / 静音与解除静音（跟随账号输出设备）
  function playSystemTone(kind: 'enter' | 'exit' | 'mute' | 'unmute') {
    if (kind === 'enter') {
      playLocalTone([880, 1320])
    } else if (kind === 'exit') {
      playLocalTone([1320, 880])
    } else if (kind === 'mute') {
      playLocalTone([440])
    } else if (kind === 'unmute') {
      playLocalTone([660])
    }
  }

  async function joinRoom(roomId: string) {
    if (currentRoom.value === roomId) return
    await ensureIceServers()

    const hadStream = !!localStream.value
    if (currentRoom.value) {
      leaveRoom({ keepStream: hadStream })
    }

    ensureAudioCtx()

    if (!localStream.value) {
      await ensureMic()
    }
    initAudioPipeline()
    
    // 刷新设备列表，确保获取最新的设备信息
    await refreshDevices()

    currentRoom.value = roomId
    ws.send({ type: 'voice-join', roomId })
    startStatsPolling()
    startLevelPolling()
  }

  function leaveRoom(opts?: { keepStream?: boolean }) {
    stopStatsPolling()
    stopLevelPolling()
    stopScreenShare()
    if (currentRoom.value) {
      ws.send({ type: 'voice-leave', roomId: currentRoom.value })
    }
    peerConnections.value.forEach(pc => pc.close())
    peerConnections.value.clear()
    pendingCandidates.clear()
    screenSenders.value.clear()
    remoteScreens.value = []
    outputAnalysers.forEach(({ src }) => src.disconnect())
    outputAnalysers.clear()
    outputCtx?.close().catch(() => {})
    outputCtx = null
    inputLevel.value = 0
    outputLevel.value = 0
    if (!opts?.keepStream) {
      localStream.value?.getTracks().forEach(t => t.stop())
      localStream.value = null
      destroyAudioPipeline()
    }
    currentRoom.value = null
    participants.value = []
    micAvailable.value = true
    micError.value = ''
    isMuted.value = false
    isDeafened.value = false
  }

  async function retryMic() {
    if (!currentRoom.value) return
    micError.value = ''
    try {
      if (localStream.value) {
        localStream.value.getTracks().forEach(t => t.stop())
      }
      localStream.value = await navigator.mediaDevices.getUserMedia({
        audio: inputDeviceId.value ? { deviceId: { exact: inputDeviceId.value } } : true
      })
      micAvailable.value = true
      micError.value = ''
      initAudioPipeline()
    } catch (e: any) {
      micAvailable.value = false
      micError.value = '麦克风仍不可用'
    }
  }

  // 麦克风 enabled 的唯一事实来源：deafen 主导（deafen 开启时强制静音，无论 mute 状态）
  function applyMicEnabled() {
    localStream.value?.getAudioTracks().forEach(t => {
      t.enabled = !isMuted.value && !isDeafened.value
    })
  }

  function toggleMute() {
    if (!micAvailable.value) return
    isMuted.value = !isMuted.value
    applyMicEnabled()
    ws.send({ type: isMuted.value ? 'voice-mute' : 'voice-unmute', roomId: currentRoom.value })
  }

  function toggleDeafen() {
    isDeafened.value = !isDeafened.value
    const audioElements = document.querySelectorAll<HTMLAudioElement>('audio[id^="audio-"]')
    if (isDeafened.value) {
      // Store current volume and mute
      audioElements.forEach(el => {
        el.dataset.originalVolume = el.volume.toString()
        el.volume = 0
      })
    } else {
      // Restore original volume
      audioElements.forEach(el => {
        const originalVolume = el.dataset.originalVolume || '1'
        el.volume = parseFloat(originalVolume)
        delete el.dataset.originalVolume
      })
    }
    // Discord 语义：deafen 同时静音麦克风
    applyMicEnabled()
  }

  function applyPreferredVideoCodec(pc: RTCPeerConnection) {
    try {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      const caps = (RTCRtpSender as any).getCapabilities?.('video')
      if (!sender || !caps?.codecs?.length) return
      const isVp9 = (m: string) => /VP9/i.test(m)
      const order = ['H264', 'VP8']
      const preferred: RTCRtpCodecCapability[] = []
      for (const name of order) {
        for (const c of caps.codecs) {
          if (!c.mimeType.toLowerCase().includes(name.toLowerCase())) continue
          if (!preferred.some(o => o.mimeType === c.mimeType)) preferred.push({ mimeType: c.mimeType })
        }
      }
      for (const c of caps.codecs) {
        if (isVp9(c.mimeType)) continue
        if (!preferred.some(o => o.mimeType === c.mimeType)) preferred.push({ mimeType: c.mimeType })
      }
      if (preferred.length) {
        sender.setCodecPreferences(preferred)
      }
    } catch {}
  }

  async function startScreenShare(opts: { width?: number; fps?: number } = {}) {
    if (!currentRoom.value) return
    currentShareOpts.value = { width: opts.width ?? 1920, fps: opts.fps ?? 30 }
    const preset = sharePresets[String(currentShareOpts.value.width)] || sharePresets['1920']
    const fps = currentShareOpts.value.fps
    const videoOpts: any = { frameRate: { ideal: fps } }
    if (preset.w > 0 && preset.h > 0) {
      videoOpts.width = { ideal: preset.w }
      videoOpts.height = { ideal: preset.h }
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoOpts, audio: false })
      screenStream.value = stream
      isScreenSharing.value = true

      const track = stream.getVideoTracks()[0]
      // 告知编码器这是屏幕内容（优先清晰度/文字），而非摄像头
      try { track.contentHint = 'detail' } catch {}

      // 强制应用所选画质/帧率：getDisplayMedia 的 ideal 约束不保证生效，
      // 用 exact 约束强制，源不支持时回退 ideal（与 changeShareQuality 一致）
      if (preset.w > 0 && preset.h > 0) {
        try {
          await track.applyConstraints({
            width: { exact: preset.w },
            height: { exact: preset.h },
            frameRate: fps > 0 ? { exact: fps } : undefined
          })
        } catch {
          try {
            await track.applyConstraints({
              width: { ideal: preset.w },
              height: { ideal: preset.h },
              frameRate: fps > 0 ? { ideal: fps } : undefined
            })
          } catch {}
        }
      } else if (fps > 0) {
        try { await track.applyConstraints({ frameRate: { ideal: fps } }) } catch {}
      }

      const settings = track.getSettings()
      sourceResolution.value = { width: settings.width || preset.w || 1920, height: settings.height || preset.h || 1080 }

      // 按源分辨率封顶所选画质（源 1080p 时选 2K → 自动降为 1080p），让标签与实际一致
      const snappedW = snapPresetToSource(currentShareOpts.value.width, sourceResolution.value.width)
      if (snappedW !== currentShareOpts.value.width) {
        currentShareOpts.value = { ...currentShareOpts.value, width: snappedW }
      }

      // 初始化码率上限：preset 上限作为起始值，自适应从此开始升降
      bitrateLimit = bitrateCeilingFor(currentShareOpts.value.width)
      goodQualityStreak = 0

      track.onended = () => { if (!isSwitching) stopScreenShare() }

      for (const [userId, pc] of peerConnections.value) {
        if (track) {
          const sender = pc.addTrack(track, stream)
          screenSenders.value.set(userId, sender)
          applyPreferredVideoCodec(pc)
          // 设码率上限 + 帧率上限（在 createOffer 前写入 sender 参数）
          try {
            const params = sender.getParameters()
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
            params.encodings[0].maxBitrate = bitrateLimit
            params.encodings[0].maxFramerate = fps
            await sender.setParameters(params)
          } catch {}
          const offer = await pc.createOffer({ iceRestart: true })
          await pc.setLocalDescription(offer)
          ws.send({ type: 'voice-offer', roomId: currentRoom.value, targetUserId: userId, data: offer })
        }
      }

      ws.send({ type: 'screen-share-start', roomId: currentRoom.value })
    } catch {
      screenStream.value = null
      isScreenSharing.value = false
    }
  }

  async function changeShareQuality(opts: { width: number; fps: number }) {
    if (!isScreenSharing.value || !screenStream.value) return
    // 按源分辨率封顶，避免选了超源档位而标签与实际不符
    const snappedW = snapPresetToSource(opts.width, sourceResolution.value.width)
    currentShareOpts.value = { width: snappedW, fps: opts.fps }
    const effOpts = { width: snappedW, fps: opts.fps }

    const src = sourceResolution.value
    const targetW = effOpts.width > 0 ? Math.min(effOpts.width, src.width) : src.width
    const targetH = src.height > 0 ? Math.round(targetW * (src.height / src.width)) : 0

    // 切换画质时重置码率上限到新 preset 的上限
    bitrateLimit = bitrateCeilingFor(effOpts.width)
    goodQualityStreak = 0

    try {
      const track = screenStream.value.getVideoTracks()[0]
      if (track) {
        await track.applyConstraints({
          width: targetW > 0 ? { exact: targetW } : undefined,
          height: targetH > 0 ? { exact: targetH } : undefined,
          frameRate: effOpts.fps > 0 ? { exact: effOpts.fps } : undefined
        })
      }
      // applyConstraints 成功后仍需把码率上限写回 sender（分辨率变化不更新 sender 参数）
      await applySenderBitrate(bitrateLimit, effOpts.fps)
    } catch {
      const scale = Math.max(src.width / targetW, 1)
      for (const sender of screenSenders.value.values()) {
        try {
          const params = sender.getParameters()
          if (!params.encodings) params.encodings = [{}]
          params.encodings[0].scaleResolutionDownBy = scale
          params.encodings[0].maxFramerate = effOpts.fps
          params.encodings[0].maxBitrate = bitrateLimit
          await sender.setParameters(params)
        } catch {}
      }
    }
  }

  function stopScreenShare() {
    if (!isScreenSharing.value) return
    ws.send({ type: 'screen-share-stop', roomId: currentRoom.value })

    for (const [, sender] of screenSenders.value) {
      try {
        sender.replaceTrack(null)
      } catch {}
    }

    screenStream.value?.getTracks().forEach(t => t.stop())
    screenStream.value = null
    isScreenSharing.value = false
    screenSenders.value.clear()
  }

  // 实时切换投屏源窗口：保留 peer connection / 语音 / 码率参数，仅用 replaceTrack 原子替换视频轨
  async function switchScreenSource() {
    if (!isScreenSharing.value || !currentRoom.value) return
    const fps = currentShareOpts.value.fps
    isSwitching = true
    try {
      const newStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps } },
        audio: false
      })
      const newTrack = newStream.getVideoTracks()[0]
      if (!newTrack) {
        newStream.getTracks().forEach(t => t.stop())
        return
      }
      try { newTrack.contentHint = 'detail' } catch {}

      // 对每路 sender 原子替换视频轨（无需重新协商）
      for (const sender of screenSenders.value.values()) {
        try { await sender.replaceTrack(newTrack) } catch {}
      }

      // 停旧轨、更新引用与源分辨率
      screenStream.value?.getTracks().forEach(t => t.stop())
      screenStream.value = newStream
      const settings = newTrack.getSettings()
      sourceResolution.value = { width: settings.width || 1920, height: settings.height || 1080 }

      newTrack.onended = () => { if (!isSwitching) stopScreenShare() }

      // 重应用当前画质/码率到新轨
      await changeShareQuality(currentShareOpts.value)
    } catch {
      // 用户取消选择器：保持原投屏不变
    } finally {
      isSwitching = false
    }
  }

  function startStatsPolling() {
    stopStatsPolling()
    prevBytesOut = 0
    prevBytesIn = 0
    prevTs = 0
    statsTimer = setInterval(pollStats, 2000)
  }

  function stopStatsPolling() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
    connectionStats.value = {
      rtt: 0, packetsLost: 0, totalPackets: 0, lossRate: 0, quality: 'unknown',
      cpuCores: navigator.hardwareConcurrency || 0,
      outBitrate: 0, outFps: 0, outWidth: 0, outHeight: 0, outLossRate: 0,
      inBitrate: 0, inFps: 0, inWidth: 0, inHeight: 0, inLossRate: 0
    }
  }

  function updateQualityFromRtt(rtt: number, lossRate: number) {
    if (rtt > 300 || lossRate > 5) return 'poor'
    if (rtt > 150 || lossRate > 2) return 'fair'
    if (rtt > 0) return 'good'
    return 'unknown'
  }

  async function pollStats() {
    if (peerConnections.value.size === 0) {
      connectionStats.value.quality = connectionStats.value.rtt > 0
        ? updateQualityFromRtt(connectionStats.value.rtt, connectionStats.value.lossRate)
        : 'fair'
      return
    }

    let bestRtt = 0, foundCp = false
    let outVideo: any = null, inVideo: any = null
    let audioIn: any = null, audioOut: any = null

    for (const pc of peerConnections.value.values()) {
      try {
        const report = await pc.getStats()
        report.forEach((stat: any) => {
          if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.state === 'in-progress')) {
            foundCp = true
            const v = Math.round(stat.currentRoundTripTime * 1000) || 0
            if (v > 0 && (!bestRtt || v < bestRtt)) bestRtt = v
          }
          if (stat.type === 'outbound-rtp' && stat.kind === 'video' && (!outVideo || (stat.bytesSent || 0) > (outVideo.bytesSent || 0))) {
            outVideo = stat
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'video' && (!inVideo || (stat.bytesReceived || 0) > (inVideo.bytesReceived || 0))) {
            inVideo = stat
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio' && !audioIn) audioIn = stat
          if (stat.type === 'outbound-rtp' && stat.kind === 'audio' && !audioOut) audioOut = stat
        })
      } catch {}
    }

    connectionStats.value.rtt = bestRtt
    const now = Date.now()
    const dt = prevTs > 0 ? (now - prevTs) / 1000 : 0

    if (outVideo) {
      const tp = outVideo.packetsSent || 0
      connectionStats.value.outLossRate = tp > 0 ? Math.round(((outVideo.packetsLost || 0) / tp) * 100) : 0
      connectionStats.value.outWidth = outVideo.frameWidth || 0
      connectionStats.value.outHeight = outVideo.frameHeight || 0
      connectionStats.value.outFps = Math.round(outVideo.framesPerSecond) || 0
      if (prevTs > 0 && outVideo.bytesSent > prevBytesOut && dt > 0) {
        connectionStats.value.outBitrate = Math.round(((outVideo.bytesSent - prevBytesOut) * 8) / dt / 1000)
      }
      prevBytesOut = outVideo.bytesSent
    } else if (isScreenSharing.value && screenStream.value) {
      const s = screenStream.value.getVideoTracks()[0]?.getSettings()
      if (s?.width) connectionStats.value.outWidth = s.width
      if (s?.height) connectionStats.value.outHeight = s.height
      if (s?.frameRate) connectionStats.value.outFps = Math.round(s.frameRate)
    } else {
      connectionStats.value.outBitrate = 0
      connectionStats.value.outLossRate = 0
      connectionStats.value.outWidth = 0
      connectionStats.value.outHeight = 0
      connectionStats.value.outFps = 0
    }

    if (inVideo) {
      const tp = inVideo.packetsReceived || 0
      connectionStats.value.inLossRate = tp > 0 ? Math.round(((inVideo.packetsLost || 0) / tp) * 100) : 0
      connectionStats.value.inWidth = inVideo.frameWidth || 0
      connectionStats.value.inHeight = inVideo.frameHeight || 0
      connectionStats.value.inFps = Math.round(inVideo.framesPerSecond) || 0
      if (prevTs > 0 && inVideo.bytesReceived > prevBytesIn && dt > 0) {
        connectionStats.value.inBitrate = Math.round(((inVideo.bytesReceived - prevBytesIn) * 8) / dt / 1000)
      }
      prevBytesIn = inVideo.bytesReceived
    } else {
      connectionStats.value.inBitrate = 0
      connectionStats.value.inLossRate = 0
      connectionStats.value.inWidth = 0
      connectionStats.value.inHeight = 0
      connectionStats.value.inFps = 0
    }

    const audioStats = audioIn || audioOut
    if (audioStats) {
      const tp = audioStats.packetsSent ?? audioStats.packetsReceived ?? 0
      connectionStats.value.packetsLost = audioStats.packetsLost ?? 0
      connectionStats.value.totalPackets = tp
      connectionStats.value.lossRate = tp > 0 ? Math.round(((audioStats.packetsLost || 0) / tp) * 100) : 0
    } else if (outVideo || inVideo) {
      connectionStats.value.lossRate = Math.max(connectionStats.value.outLossRate, connectionStats.value.inLossRate)
    }

    prevTs = now

    const q = updateQualityFromRtt(connectionStats.value.rtt, connectionStats.value.lossRate)
    if (q !== 'unknown') {
      connectionStats.value.quality = q
    } else if (foundCp) {
      connectionStats.value.quality = 'fair'
    }

    // 自适应码率：仅在投屏中生效，依据上行丢包率/RTT 升降 maxBitrate
    if (isScreenSharing.value && screenSenders.value.size > 0 && bitrateLimit > 0) {
      const ceiling = bitrateCeilingFor(currentShareOpts.value.width)
      const poor = connectionStats.value.outLossRate > 5 || connectionStats.value.rtt > 300
      const good = connectionStats.value.outLossRate < 2 && connectionStats.value.rtt > 0 && connectionStats.value.rtt < 150

      if (poor) {
        // 立即降档：×0.7，下限 BITRATE_FLOOR
        const next = Math.max(Math.round(bitrateLimit * 0.7), BITRATE_FLOOR)
        goodQualityStreak = 0
        if (next < bitrateLimit) {
          bitrateLimit = next
          applySenderBitrate(bitrateLimit)
        }
      } else if (good) {
        // 升档需连续 3 次好质量，避免抖动
        goodQualityStreak++
        if (goodQualityStreak >= 3 && bitrateLimit < ceiling) {
          const next = Math.min(Math.round(bitrateLimit * 1.3), ceiling)
          if (next > bitrateLimit) {
            bitrateLimit = next
            applySenderBitrate(bitrateLimit)
          }
          goodQualityStreak = 0
        }
      } else {
        // 中等质量：既不升也不降，重置升档计数
        goodQualityStreak = 0
      }
    }
  }

  // perfect negotiation：双方同时 offer（glare）时按 userId 大小约定礼貌方，
  // 礼貌方 rollback 后应答对方 offer，非礼貌方忽略对方 offer（由礼貌方收敛）
  function isPolite(peerId: string): boolean {
    return (authStore.user?.id ?? '') < peerId
  }

  async function flushPendingCandidates(userId: string, pc: RTCPeerConnection) {
    const pending = pendingCandidates.get(userId) || []
    pendingCandidates.set(userId, [])
    for (const cand of pending) {
      try { await pc.addIceCandidate(new RTCIceCandidate(cand)) } catch {}
    }
  }

  function handleSignal(data: any) {
    if (!currentRoom.value) return
    const pc = getOrCreatePeerConnection(data.userId)
    switch (data.type) {
      case 'voice-offer': {
        const polite = isPolite(data.userId)
        ;(async () => {
          try {
            if (pc.signalingState === 'have-local-offer') {
              if (!polite) return
              await pc.setLocalDescription({ type: 'rollback' })
            }
            await pc.setRemoteDescription(new RTCSessionDescription(data.data))
            await flushPendingCandidates(data.userId, pc)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            ws.send({ type: 'voice-answer', roomId: currentRoom.value, targetUserId: data.userId, data: answer })
          } catch {}
        })()
        break
      }
      case 'voice-answer': {
        ;(async () => {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.data))
            await flushPendingCandidates(data.userId, pc)
          } catch {}
        })()
        break
      }
      case 'voice-ice-candidate': {
        ;(async () => {
          const cand = new RTCIceCandidate(data.data)
          if (!pc.remoteDescription) {
            const arr = pendingCandidates.get(data.userId) || []
            arr.push(data.data)
            pendingCandidates.set(data.userId, arr)
          } else {
            try { await pc.addIceCandidate(cand) } catch {}
          }
        })()
        break
      }
    }
  }

  // 连接失败自动重连计数（按对端 userId）
  const reconnectAttempts = new Map<string, number>()

  // failed 后延迟重新协商（iceRestart），让因打洞/TURN 抖动死掉的连接自动恢复
  function scheduleReconnect(userId: string, pc: RTCPeerConnection) {
    const attempt = (reconnectAttempts.get(userId) || 0) + 1
    if (attempt > 3) {
      reconnectAttempts.delete(userId)
      return
    }
    reconnectAttempts.set(userId, attempt)
    setTimeout(() => {
      const cur = peerConnections.value.get(userId)
      if (!cur || cur !== pc) return
      if (cur.connectionState === 'connected') {
        reconnectAttempts.delete(userId)
        return
      }
      if (!currentRoom.value) return
      try {
        cur.createOffer({ iceRestart: true })
          .then((offer) => cur.setLocalDescription(offer))
          .then(() => {
            if (currentRoom.value) {
              ws.send({ type: 'voice-offer', roomId: currentRoom.value, targetUserId: userId, data: pc.localDescription })
            }
          })
          .catch(() => {})
      } catch {}
    }, 2000 * attempt)
  }

  function getOrCreatePeerConnection(userId: string): RTCPeerConnection {
    let pc = peerConnections.value.get(userId)
    if (pc) return pc

    const config = { iceServers: iceServersCache || fallbackIceServers }
    pc = new RTCPeerConnection(config)
    if (localStream.value) {
      if (sentAudioTrack && micDest) {
        pc!.addTrack(sentAudioTrack, micDest.stream)
      } else {
        localStream.value.getTracks().forEach(track => {
          pc!.addTrack(track, localStream.value!)
        })
      }
    } else {
      try {
        pc!.addTransceiver('audio', { direction: 'recvonly' })
        pc!.addTransceiver('video', { direction: 'recvonly' })
      } catch {}
    }

    if (screenStream.value && isScreenSharing.value) {
      screenStream.value.getVideoTracks().forEach(track => {
        const sender = pc!.addTrack(track, screenStream.value!)
        screenSenders.value.set(userId, sender)
      })
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && currentRoom.value) {
        ws.send({ type: 'voice-ice-candidate', roomId: currentRoom.value, targetUserId: userId, data: event.candidate })
      }
    }

    pc.ontrack = (event) => {
      const track = event.track
      if (track.kind === 'audio') {
        const audioEl = document.createElement('audio')
        audioEl.srcObject = event.streams[0]
        audioEl.autoplay = true
        // deafen 状态下新建音频元素必须保持静音（修复新用户/重连绕过 deafen）
        if (isDeafened.value) {
          audioEl.dataset.originalVolume = outputVolume.value.toString()
          audioEl.volume = 0
        } else {
          audioEl.volume = outputVolume.value
        }
        audioEl.id = `audio-${userId}`
        if (outputDeviceId.value) {
          ;(audioEl as any).setSinkId(outputDeviceId.value).catch(() => {})
        }
        const existing = document.getElementById(`audio-${userId}`)
        if (existing) existing.remove()
        document.body.appendChild(audioEl)
        // 自动播放重试：远程音频可能因浏览器自动播放策略或轨道未就绪而 play 失败，
        // 持续重试直到播放成功（用户与页面交互后即可解锁）
        const playAudio = () => {
          audioEl.play().catch(() => {
            setTimeout(playAudio, 800)
          })
        }
        playAudio()
        try {
          ensureOutputCtx()
          const existingAnalyser = outputAnalysers.get(userId)
          if (existingAnalyser) existingAnalyser.src.disconnect()
          const src = outputCtx!.createMediaStreamSource(event.streams[0])
          const analyser = outputCtx!.createAnalyser()
          analyser.fftSize = 512
          src.connect(analyser)
          outputAnalysers.set(userId, { src, analyser })
        } catch {}
      } else if (track.kind === 'video') {
        const stream = event.streams[0] || new MediaStream([track])
        remoteScreens.value = [
          ...remoteScreens.value.filter(e => e.userId !== userId),
          { userId, stream, ts: Date.now() }
        ]
        track.onended = () => {
          cleanupRemoteScreen(userId)
        }
      }
    }

    pc.onconnectionstatechange = () => {
      const st = pc!.connectionState
      if (st === 'disconnected' || st === 'failed') {
        remoteScreens.value = remoteScreens.value.filter(e => e.userId !== userId)
      }
      if (st === 'connected') {
        reconnectAttempts.delete(userId)
      }
      if (st === 'failed') {
        // 连接失败自动重连：ICE 打洞/TURN 抖动导致连接死亡时，
        // 延迟重新协商（iceRestart）让语音/投屏恢复，最多重试 3 次
        scheduleReconnect(userId, pc!)
      }
    }

    peerConnections.value.set(userId, pc)
    return pc
  }

  async function createOffer(userId: string) {
    if (!currentRoom.value) return
    // 投屏中：对端重连（voice-user-joined / 新成员加入）时强制重建 pc，
    // 让 getOrCreatePeerConnection 重新 addTrack 投屏视频轨并协商过去，
    // 否则对端重建连接后收不到投屏画面
    if (isScreenSharing.value && screenStream.value) {
      const old = peerConnections.value.get(userId)
      if (old) {
        try { old.close() } catch {}
        peerConnections.value.delete(userId)
        screenSenders.value.delete(userId)
      }
      const pc = getOrCreatePeerConnection(userId)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      ws.send({ type: 'voice-offer', roomId: currentRoom.value, targetUserId: userId, data: offer })
      return
    }
    const pc = getOrCreatePeerConnection(userId)
    // 协商在途或已建立连接则跳过，避免重复/冲突 offer
    if (pc.signalingState !== 'stable') return
    if (pc.connectionState === 'connected' && pc.remoteDescription) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    ws.send({ type: 'voice-offer', roomId: currentRoom.value, targetUserId: userId, data: offer })
  }

  // 新加入者收到成员列表后，主动对尚未建立连接的成员发起 offer，
  // 避免完全依赖"老成员收到 voice-user-joined 才建连"的单一路径
  function ensureConnections(members: string[]) {
    if (!currentRoom.value) return
    const me = authStore.user?.id
    for (const uid of members) {
      if (!uid || uid === me) continue
      const pc = peerConnections.value.get(uid)
      const connected = !!pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting') && !!pc.remoteDescription
      if (connected) continue
      createOffer(uid)
    }
  }

  function cleanupRemoteScreen(userId: string) {
    remoteScreens.value = remoteScreens.value.filter(e => e.userId !== userId)
    const audioEl = document.getElementById(`audio-${userId}`)
    if (audioEl) audioEl.remove()
  }

  function ensureVideoTransceiver(userId: string) {
    const pc = peerConnections.value.get(userId)
    if (!pc) return
    try {
      if (!pc.getTransceivers().some(t => t.receiver?.track?.kind === 'video')) {
        pc.addTransceiver('video', { direction: 'recvonly' })
      }
    } catch {}
  }

  async function requestScreenRefresh() {
    if (!currentRoom.value) return
    for (const [userId, pc] of peerConnections.value) {
      ensureVideoTransceiver(userId)
      try {
        const offer = await pc.createOffer({ iceRestart: true })
        await pc.setLocalDescription(offer)
        ws.send({ type: 'voice-offer', roomId: currentRoom.value, targetUserId: userId, data: offer })
      } catch {}
    }
  }

  function handleVoiceRoomMembers(data: any) {
    if (data.roomId) {
      voiceRoomMembers.value = {
        ...voiceRoomMembers.value,
        [data.roomId]: data.members || []
      }
    }
  }

  const VOICE_STATE_TTL = 60000

  function voiceStateKey() {
    return `z80z-chat_voice_reconnect_${authStore.user?.id || 'guest'}`
  }

  function saveVoiceState(serverId?: string) {
    if (!currentRoom.value) return
    try {
      localStorage.setItem(voiceStateKey(), JSON.stringify({
        roomId: currentRoom.value,
        serverId: serverId || null,
        isMuted: isMuted.value,
        isDeafened: isDeafened.value,
        ts: Date.now()
      }))
    } catch {}
  }

  function loadVoiceState(): { roomId: string; serverId: string | null; isMuted: boolean; isDeafened: boolean } | null {
    try {
      const raw = localStorage.getItem(voiceStateKey())
      if (!raw) return null
      const state = JSON.parse(raw)
      if (Date.now() - state.ts > VOICE_STATE_TTL) {
        localStorage.removeItem(voiceStateKey())
        return null
      }
      return { roomId: state.roomId, serverId: state.serverId || null, isMuted: state.isMuted, isDeafened: state.isDeafened }
    } catch {
      return null
    }
  }

  function clearVoiceState() {
    localStorage.removeItem(voiceStateKey())
  }

  async function rejoinRoom(roomId: string) {
    peerConnections.value.forEach(pc => pc.close())
    peerConnections.value.clear()
    pendingCandidates.clear()
    screenSenders.value.clear()
    remoteScreens.value = []
    outputAnalysers.forEach(({ src }) => src.disconnect())
    outputAnalysers.clear()
    await ensureIceServers()
    if (!localStream.value) {
      await ensureMic()
    }
    // 新麦克风轨道默认 enabled=true，重连后须恢复静音/耳聋状态
    applyMicEnabled()
    initAudioPipeline()
    await refreshDevices()
    currentRoom.value = roomId
    ws.send({ type: 'voice-join', roomId })
    startStatsPolling()
    startLevelPolling()
  }

  return {
    currentRoom, participants, voiceRoomMembers, isMuted, isDeafened, localStream,
    micAvailable, micError, screenStream, isScreenSharing, remoteScreens,
    connectionStats, sharePresets, currentShareOpts, sourceResolution,
    inputDevices, outputDevices, inputDeviceId, outputDeviceId, inputVolume, outputVolume,
    outputSelectionSupported, screenShareSupported, inputLevel, outputLevel,
    joinRoom, leaveRoom, retryMic, toggleMute, toggleDeafen,
    startScreenShare, changeShareQuality, stopScreenShare, switchScreenSource,
    refreshDevices, changeInputDevice, changeOutputDevice, setInputVolume, setOutputVolume,
    playTestSound, playSystemTone,
    handleSignal, createOffer, ensureConnections, cleanupRemoteScreen, handleVoiceRoomMembers, requestScreenRefresh,
    saveVoiceState, loadVoiceState, clearVoiceState, rejoinRoom
  }
})
