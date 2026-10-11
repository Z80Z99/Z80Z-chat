export type AudioTestKind = 'microphone' | 'speaker'
export type AudioTestStatus = 'idle' | 'starting' | 'running' | 'error'

export interface AudioTestState {
  kind: AudioTestKind | null
  status: AudioTestStatus
  level: number
  error: string
}

export interface AudioTestOptions {
  inputDeviceId: string
  outputDeviceId: string
  inputVolume: number
  outputVolume: number
  deafened?: boolean
}

export interface AudioTestDependencies {
  secureContext: () => boolean
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createContext: () => AudioContext
  createAudio: () => HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer: (id: ReturnType<typeof setTimeout>) => void
  bindInterrupt?: (stop: () => void) => () => void
  changed?: () => void
}

type TestRun = {
  kind: AudioTestKind
  context?: AudioContext
  stream?: MediaStream
  source?: MediaStreamAudioSourceNode
  analyser?: AnalyserNode
  gain?: GainNode
  oscillator?: OscillatorNode
  audio?: HTMLAudioElement
  frame?: number
  timer?: ReturnType<typeof setTimeout>
  trackListeners: Array<{ track: MediaStreamTrack; listener: () => void }>
  cleaned: boolean
}

const clamp = (value: number, max: number) => Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0
const effectiveDeviceId = (id: string) => id === '' || id === 'default' ? 'default' : id

function browserDependencies(): AudioTestDependencies {
  return {
    secureContext: () => window.isSecureContext,
    getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
    createContext: () => {
      const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Constructor) throw new Error('浏览器不支持音频测试，请更新浏览器。')
      return new Constructor()
    },
    createAudio: () => new Audio(),
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: id => window.cancelAnimationFrame(id),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: id => clearTimeout(id),
    bindInterrupt: stop => {
      const visibility = () => { if (document.visibilityState !== 'visible') stop() }
      document.addEventListener('visibilitychange', visibility)
      window.addEventListener('blur', stop)
      return () => {
        document.removeEventListener('visibilitychange', visibility)
        window.removeEventListener('blur', stop)
      }
    }
  }
}

function errorMessage(error: unknown, kind: AudioTestKind): string {
  const name = (error as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return kind === 'microphone' ? '麦克风权限被拒绝，请在浏览器设置中允许访问后重试。' : '浏览器阻止了测试音，请允许音频播放后重试。'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return kind === 'microphone' ? '未找到所选麦克风，请重新选择设备。' : '未找到所选扬声器，请重新选择设备。'
  if (name === 'NotReadableError' || name === 'AbortError') return '设备无法使用，可能已被其他程序占用或断开，请重试。'
  return error instanceof Error && error.message ? error.message : '音频测试失败，请检查设备后重试。'
}

/** Owns only local test media; it never joins a room or attaches a call sender. */
export function createAudioDeviceTest(
  initial: AudioTestOptions,
  changed: (state: AudioTestState) => void,
  dependencies: AudioTestDependencies = browserDependencies()
) {
  let options = { ...initial, inputVolume: clamp(initial.inputVolume, 2), outputVolume: clamp(initial.outputVolume, 1) }
  let state: AudioTestState = { kind: null, status: 'idle', level: 0, error: '' }
  let active: TestRun | null = null
  let disposed = false
  const publish = (next: AudioTestState) => { state = next; changed({ ...next }) }
  const current = (run: TestRun) => !disposed && active === run

  function release(run: TestRun) {
    if (run.cleaned) return
    run.cleaned = true
    if (run.frame !== undefined) dependencies.cancelFrame(run.frame)
    if (run.timer !== undefined) dependencies.clearTimer(run.timer)
    for (const { track, listener } of run.trackListeners) track.removeEventListener('ended', listener)
    for (const track of run.stream?.getTracks() || []) track.stop()
    try { run.oscillator?.stop() } catch { /* An oscillator may not have started. */ }
    for (const node of [run.oscillator, run.source, run.gain, run.analyser]) {
      try { node?.disconnect() } catch { /* Already disconnected by the browser. */ }
    }
    if (run.audio) {
      run.audio.pause()
      run.audio.srcObject = null
      run.audio.removeAttribute('src')
      run.audio.load()
    }
    if (run.context && run.context.state !== 'closed') void run.context.close().catch(() => {})
  }

  function stop() {
    const previous = active
    active = null
    if (previous) release(previous)
    publish({ kind: null, status: 'idle', level: 0, error: '' })
  }

  function fail(run: TestRun, error: unknown) {
    if (!current(run)) return
    active = null
    release(run)
    publish({ kind: run.kind, status: 'error', level: 0, error: errorMessage(error, run.kind) })
  }

  function begin(kind: AudioTestKind): TestRun | null {
    if (disposed) return null
    stop()
    const run: TestRun = { kind, trackListeners: [], cleaned: false }
    active = run
    publish({ kind, status: 'starting', level: 0, error: '' })
    if (!dependencies.secureContext()) {
      fail(run, new Error('音频测试需要 HTTPS 或本机 localhost，请使用安全地址打开。'))
      return null
    }
    return run
  }

  function setGain(run: TestRun, value: number) {
    if (run.gain) run.gain.gain.setTargetAtTime(value, run.context!.currentTime, 0.02)
  }

  async function startMicrophone() {
    const run = begin('microphone')
    if (!run) return
    try {
      if (!dependencies.getUserMedia) throw new Error('浏览器不支持麦克风访问，请更新浏览器。')
      const deviceId = options.inputDeviceId
      const stream = await dependencies.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false })
      if (!current(run)) { for (const track of stream.getTracks()) track.stop(); return }
      run.stream = stream
      run.context = dependencies.createContext()
      run.source = run.context.createMediaStreamSource(stream)
      run.gain = run.context.createGain()
      run.analyser = run.context.createAnalyser()
      run.analyser.fftSize = 512
      run.source.connect(run.gain)
      run.gain.connect(run.analyser)
      setGain(run, options.inputVolume)
      for (const track of stream.getTracks()) {
        const listener = () => { fail(run, new Error('麦克风已断开，请重新选择设备。')); dependencies.changed?.() }
        track.addEventListener('ended', listener)
        run.trackListeners.push({ track, listener })
      }
      await run.context.resume()
      if (!current(run)) return
      dependencies.changed?.()
      publish({ kind: 'microphone', status: 'running', level: 0, error: '' })
      const samples = new Uint8Array(run.analyser.fftSize)
      const measure = () => {
        if (!current(run)) return
        run.analyser!.getByteTimeDomainData(samples)
        let squares = 0
        for (const value of samples) squares += ((value - 128) / 128) ** 2
        const level = Math.min(1, Math.sqrt(squares / samples.length) * 3)
        publish({ kind: 'microphone', status: 'running', level, error: '' })
        run.frame = dependencies.requestFrame(measure)
      }
      measure()
    } catch (error) { fail(run, error) }
  }

  async function startSpeaker() {
    const run = begin('speaker')
    if (!run) return
    try {
      if (options.deafened) throw new Error('当前已关闭声音，请先取消耳机静音再测试。')
      run.context = dependencies.createContext()
      run.oscillator = run.context.createOscillator()
      run.gain = run.context.createGain()
      const destination = run.context.createMediaStreamDestination()
      run.stream = destination.stream
      run.oscillator.type = 'sine'
      run.oscillator.frequency.value = 440
      run.oscillator.connect(run.gain)
      run.gain.connect(destination)
      setGain(run, options.outputVolume * 0.06)
      const audio = dependencies.createAudio()
      run.audio = audio
      audio.srcObject = destination.stream
      audio.volume = 1
      if (audio.setSinkId) await audio.setSinkId(options.outputDeviceId || 'default')
      else if (options.outputDeviceId && options.outputDeviceId !== 'default') throw new Error('浏览器不支持选择扬声器，请选择系统默认设备后测试。')
      if (!current(run)) return
      await run.context.resume()
      if (!current(run)) return
      run.oscillator.start()
      await audio.play()
      if (!current(run)) return
      publish({ kind: 'speaker', status: 'running', level: 0, error: '' })
      run.timer = dependencies.setTimer(stop, 1200)
    } catch (error) { fail(run, error) }
  }

  function update(next: AudioTestOptions) {
    // enumerateDevices can reveal the same default microphone after permission is
    // granted. That refresh must not cancel the test which granted the permission.
    const capturedInputId = active?.kind === 'microphone'
      ? active.stream?.getAudioTracks?.()[0]?.getSettings?.().deviceId : undefined
    const inputChanged = effectiveDeviceId(options.inputDeviceId) !== effectiveDeviceId(next.inputDeviceId) &&
      (!capturedInputId || capturedInputId !== next.inputDeviceId)
    const outputChanged = effectiveDeviceId(options.outputDeviceId) !== effectiveDeviceId(next.outputDeviceId)
    const deviceChanged = active?.kind === 'microphone' ? inputChanged : active?.kind === 'speaker' ? outputChanged : false
    options = { ...next, inputVolume: clamp(next.inputVolume, 2), outputVolume: clamp(next.outputVolume, 1) }
    if (deviceChanged || (options.deafened && active?.kind === 'speaker')) stop()
    else if (active) setGain(active, active.kind === 'microphone' ? options.inputVolume : options.outputVolume * 0.06)
  }

  const unbind = dependencies.bindInterrupt?.(stop)
  function dispose() {
    if (disposed) return
    disposed = true
    stop()
    unbind?.()
  }

  return { startMicrophone, startSpeaker, stop, update, dispose, getState: () => ({ ...state }) }
}
