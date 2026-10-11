<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { ScreenPlaybackState, ScreenPlaybackStatus } from '../utils/screen-playback'

const props = withDefaults(defineProps<{ userId: string; stream: MediaStream; active?: boolean; name?: string; local?: boolean }>(),
  { active: true, name: '', local: false })
const emit = defineEmits<{ (event: 'refresh'): void; (event: 'playback', value: ScreenPlaybackState): void }>()
const containerRef = ref<HTMLDivElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const status = ref<ScreenPlaybackStatus>('waiting')
const paused = ref(true)
const fps = ref<number | null>(null)
const framesPresented = ref<number | null>(null)
const videoResolution = ref({ width: 0, height: 0 })
const isFullscreen = ref(false)
const fullscreenPending = ref(false)
const fullscreenError = ref('')
const playbackError = ref('')
const manualPaused = ref(false)
const playPending = ref(false)

let mounted = false
let disposed = false
let bindingGeneration = 0
let playbackGeneration = 0
let fullscreenGeneration = 0
let fullscreenDesired = false
let boundVideo: HTMLVideoElement | null = null
let boundContainer: HTMLDivElement | null = null
let boundStream: MediaStream | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
let frameRequest: number | null = null
let pendingPlay: object | null = null
let retryCount = 0
let browserBlocked = false
let streamEnded = false
let autoRefreshed = false
let playbackStartedAt = 0
let sampleAt = 0
let sampleCount = 0
let presentedSample: number | null = null
let observedFrames = 0
let lastReported = ''
const mediaListeners: Array<{ type: string; listener: EventListener }> = []
const trackListeners: Array<{ track: MediaStreamTrack; type: string; listener: EventListener }> = []
const streamListeners: Array<{ type: string; listener: EventListener }> = []

const visible = () => document.visibilityState !== 'hidden'
const canPlay = () => mounted && !disposed && props.active && visible() && !manualPaused.value && !streamEnded
const isBinding = (generation: number, element = boundVideo, stream = boundStream) => mounted && !disposed &&
  generation === bindingGeneration && boundVideo === element && boundStream === stream && element?.srcObject === stream
const isPlayback = (binding: number, playback: number, element: HTMLVideoElement) => isBinding(binding, element) &&
  playback === playbackGeneration && canPlay()

function reportPlayback() {
  if (disposed) return
  const currentTime = Number.isFinite(boundVideo?.currentTime) ? Math.max(0, boundVideo!.currentTime) : 0
  const value: ScreenPlaybackState = { status: status.value, paused: paused.value, ...videoResolution.value,
    fps: fps.value, framesPresented: framesPresented.value, currentTime }
  const serialized = JSON.stringify(value)
  if (serialized !== lastReported) { lastReported = serialized; emit('playback', value) }
}

function setStatus(value: ScreenPlaybackStatus) { status.value = value; reportPlayback() }
function readResolution(element = boundVideo) {
  if (element) videoResolution.value = { width: element.videoWidth || 0, height: element.videoHeight || 0 }
}

function clearRetry() { if (retryTimer !== null) clearTimeout(retryTimer); retryTimer = null }
function stopFrameDetection() {
  if (frameRequest !== null && boundVideo?.cancelVideoFrameCallback) boundVideo.cancelVideoFrameCallback(frameRequest)
  frameRequest = null
  if (checkTimer !== null) clearInterval(checkTimer)
  checkTimer = null
  fps.value = null
}
function invalidatePlayback() {
  playbackGeneration++
  pendingPlay = null
  playPending.value = false
  clearRetry()
  stopFrameDetection()
}

function readPresentedFrames(element: HTMLVideoElement) {
  if (typeof element.getVideoPlaybackQuality !== 'function') return null
  try {
    const quality = element.getVideoPlaybackQuality(), total = quality.totalVideoFrames
    const dropped = Number.isFinite(quality.droppedVideoFrames) ? Math.max(0, quality.droppedVideoFrames) : 0
    return Number.isFinite(total) && total >= 0 ? Math.max(0, total - dropped) : null
  } catch { return null }
}

function startFrameDetection() {
  const element = boundVideo
  if (!element || checkTimer !== null || !canPlay() || (element.paused && !pendingPlay)) return
  const binding = bindingGeneration, playback = playbackGeneration
  playbackStartedAt = Date.now()
  sampleAt = playbackStartedAt
  observedFrames = 0
  sampleCount = 0
  presentedSample = framesPresented.value
  const hasFrameCallback = typeof element.requestVideoFrameCallback === 'function'
  if (!hasFrameCallback) {
    framesPresented.value = readPresentedFrames(element)
    sampleCount = framesPresented.value || 0
  }
  const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
    if (!isPlayback(binding, playback, element) || element.paused) return
    frameRequest = null
    observedFrames++
    if (Number.isFinite(metadata.presentedFrames)) framesPresented.value = metadata.presentedFrames
    if (metadata.width > 0 && metadata.height > 0) videoResolution.value = { width: metadata.width, height: metadata.height }
    if (status.value !== 'playing') setStatus('playing')
    if (isPlayback(binding, playback, element) && !element.paused) frameRequest = element.requestVideoFrameCallback(onFrame)
  }
  if (hasFrameCallback) frameRequest = element.requestVideoFrameCallback(onFrame)
  checkTimer = setInterval(() => {
    if (!isPlayback(binding, playback, element) || (element.paused && !pendingPlay)) return
    const now = Date.now(), elapsed = now - sampleAt
    readResolution(element)
    if (elapsed >= 1000) {
      if (hasFrameCallback) {
        const count = framesPresented.value !== null && presentedSample !== null ? Math.max(0, framesPresented.value - presentedSample) : observedFrames
        fps.value = Math.round(count * 1000 / elapsed)
        presentedSample = framesPresented.value
        observedFrames = 0
      }
      else {
        const total = readPresentedFrames(element)
        framesPresented.value = total
        fps.value = total === null ? null : Math.round(Math.max(0, total - sampleCount) * 1000 / elapsed)
        sampleCount = total || 0
      }
      sampleAt = now
    }
    // A still frame can legitimately have no new frame callbacks. Only missing
    // playable data is a stall; decoded static or dark content is never "black".
    if (element.readyState < 2 && now - playbackStartedAt >= 5000) {
      status.value = 'stalled'
      const tracks = boundStream?.getVideoTracks() || []
      if (!props.local && !autoRefreshed && tracks.some(track => track.readyState === 'live' && !track.muted)) {
        autoRefreshed = true
        emit('refresh')
      }
    } else if (element.readyState >= 2 && videoResolution.value.width > 0) status.value = 'playing'
    if (isPlayback(binding, playback, element)) reportPlayback()
  }, 1000)
}

function pauseRendering() {
  invalidatePlayback()
  boundVideo?.pause()
  paused.value = true
  setStatus(streamEnded ? 'ended' : 'paused')
}

function tryPlay(explicit = false) {
  const element = boundVideo
  if (!element || !element.srcObject || !canPlay() || (browserBlocked && !explicit) || pendingPlay) return
  if (explicit) { browserBlocked = false; retryCount = 0; playbackError.value = '' }
  const binding = bindingGeneration, playback = playbackGeneration, request = {}
  pendingPlay = request
  playPending.value = true
  setStatus(element.readyState >= 1 ? 'loading' : 'waiting')
  if (!isPlayback(binding, playback, element)) return
  let result: Promise<void> | undefined
  try { result = element.play() } catch (error) { result = Promise.reject(error) }
  startFrameDetection()
  Promise.resolve(result).then(() => {
    if (pendingPlay === request) { pendingPlay = null; playPending.value = false }
    if (!isPlayback(binding, playback, element)) {
      if (!canPlay() || element !== boundVideo) element.pause()
      return
    }
    retryCount = 0
    paused.value = element.paused
    readResolution(element)
    setStatus(element.paused ? 'paused' : element.readyState >= 2 ? 'playing' : 'loading')
    startFrameDetection()
  }).catch((error: { name?: string }) => {
    if (pendingPlay === request) { pendingPlay = null; playPending.value = false }
    if (!isPlayback(binding, playback, element)) return
    stopFrameDetection()
    paused.value = true
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      browserBlocked = true
      setStatus('blocked')
    } else if (error?.name === 'AbortError' || error?.name === 'InvalidStateError') {
      setStatus('waiting')
      if (retryCount++ < 5) retryTimer = setTimeout(() => {
        retryTimer = null
        if (isPlayback(binding, playback, element)) tryPlay()
      }, 500)
    } else {
      playbackError.value = '共享画面无法播放，请重新连接或更换浏览器。'
      setStatus('error')
    }
  })
}

function togglePlay() {
  if (manualPaused.value || browserBlocked || status.value === 'error' || (paused.value && !pendingPlay)) {
    manualPaused.value = false
    tryPlay(true)
  } else {
    manualPaused.value = true
    pauseRendering()
  }
}

function onLoadedMetadata() {
  readResolution()
  if (canPlay() && !browserBlocked) tryPlay()
  else reportPlayback()
}
function onCanPlay() { if (canPlay() && !browserBlocked) tryPlay() }
function onPlaying() {
  if (!canPlay()) { boundVideo?.pause(); return }
  if (!boundVideo || boundVideo.paused) return
  paused.value = false
  readResolution()
  setStatus(boundVideo.readyState >= 2 ? 'playing' : 'loading')
  startFrameDetection()
}
function onPause() {
  if (boundVideo && !boundVideo.paused) return
  stopFrameDetection()
  paused.value = true
  if (!browserBlocked && status.value !== 'error') setStatus(streamEnded ? 'ended' : 'paused')
}
function onError() {
  if (!boundVideo?.error) return
  invalidatePlayback()
  paused.value = true
  playbackError.value = '共享画面播放出错，请重新连接。'
  setStatus('error')
}

function clearTrackListeners() {
  for (const entry of trackListeners) entry.track.removeEventListener(entry.type, entry.listener)
  trackListeners.length = 0
}
function bindTracks() {
  clearTrackListeners()
  const binding = bindingGeneration, element = boundVideo, stream = boundStream
  if (!element || !stream) return
  const tracks = stream.getVideoTracks()
  streamEnded = tracks.length > 0 && tracks.every(track => track.readyState === 'ended')
  for (const track of tracks) {
    for (const type of ['ended', 'mute', 'unmute']) {
      const listener = () => {
        if (!isBinding(binding, element, stream)) return
        streamEnded = stream.getVideoTracks().length > 0 && stream.getVideoTracks().every(value => value.readyState === 'ended')
        if (streamEnded) pauseRendering()
        else if (type === 'unmute' && canPlay()) tryPlay()
      }
      track.addEventListener(type, listener)
      trackListeners.push({ track, type, listener })
    }
  }
}

type NativeFullscreenVideo = HTMLVideoElement & { webkitDisplayingFullscreen?: boolean; webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void }
function ownsFullscreen(element = boundVideo, container = boundContainer) {
  const full = document.fullscreenElement
  return !!(full && (full === container || full === element || container?.contains(full))) ||
    !!(element as NativeFullscreenVideo | null)?.webkitDisplayingFullscreen
}
function exitOwnedFullscreen(element = boundVideo, container = boundContainer) {
  if (!ownsFullscreen(element, container)) return
  const binding = bindingGeneration, generation = fullscreenGeneration
  const reportError = () => {
    if (!disposed && props.active && binding === bindingGeneration && generation === fullscreenGeneration) fullscreenError.value = '无法退出全屏，请使用浏览器的退出全屏按钮。'
  }
  try {
    const full = document.fullscreenElement
    const ownsDocumentFullscreen = !!(full && (full === element || full === container || container?.contains(full)))
    if (ownsDocumentFullscreen && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(reportError)
    } else (element as NativeFullscreenVideo | null)?.webkitExitFullscreen?.()
  } catch { reportError() }
}
function onFsChange() {
  if (disposed) return
  isFullscreen.value = ownsFullscreen()
  if (!isFullscreen.value && !fullscreenPending.value) fullscreenDesired = false
  if (!props.active && isFullscreen.value) exitOwnedFullscreen()
}
function onWebkitBeginFullscreen() { if (!disposed) { isFullscreen.value = true; if (!props.active) exitOwnedFullscreen() } }
function onWebkitEndFullscreen() { if (!disposed) isFullscreen.value = false }

async function toggleFullscreen() {
  const element = boundVideo as NativeFullscreenVideo | null
  const container = boundContainer
  if (!element || !props.active || disposed || fullscreenPending.value) return
  fullscreenError.value = ''
  if (ownsFullscreen(element)) { fullscreenDesired = false; fullscreenGeneration++; exitOwnedFullscreen(element); return }
  const request = ++fullscreenGeneration, binding = bindingGeneration
  fullscreenPending.value = true
  fullscreenDesired = true
  try {
    if (container?.requestFullscreen) await container.requestFullscreen()
    else if (element.requestFullscreen) await element.requestFullscreen()
    else if (element.webkitEnterFullscreen) element.webkitEnterFullscreen()
    else throw new Error('unsupported')
    if (disposed || !props.active || binding !== bindingGeneration || request !== fullscreenGeneration) {
      if (disposed || !props.active || binding !== bindingGeneration || !fullscreenDesired) exitOwnedFullscreen(element, container)
      return
    }
    isFullscreen.value = ownsFullscreen(element)
  } catch {
    if (!disposed && props.active && binding === bindingGeneration && request === fullscreenGeneration) {
      isFullscreen.value = ownsFullscreen(element, container)
      if (!isFullscreen.value) { fullscreenDesired = false; fullscreenError.value = '浏览器未能进入全屏，请重新点击或使用浏览器全屏。' }
    }
  } finally { if (request === fullscreenGeneration) fullscreenPending.value = false }
}

function clearBinding() {
  invalidatePlayback()
  clearTrackListeners()
  if (boundStream) for (const entry of streamListeners) boundStream.removeEventListener(entry.type, entry.listener)
  streamListeners.length = 0
  if (boundVideo) {
    for (const entry of mediaListeners) boundVideo.removeEventListener(entry.type, entry.listener)
    boundVideo.pause()
    boundVideo.srcObject = null
  }
  mediaListeners.length = 0
  boundVideo = null
  boundContainer = null
  boundStream = null
}
function bind() {
  if (!mounted || disposed || !videoRef.value) return
  fullscreenGeneration++
  fullscreenDesired = false
  fullscreenPending.value = false
  exitOwnedFullscreen()
  bindingGeneration++
  clearBinding()
  boundVideo = videoRef.value
  boundContainer = containerRef.value
  boundStream = props.stream
  boundVideo.muted = true
  boundVideo.srcObject = props.stream
  paused.value = true
  fps.value = null
  framesPresented.value = null
  videoResolution.value = { width: 0, height: 0 }
  playbackError.value = ''
  fullscreenError.value = ''
  browserBlocked = false
  streamEnded = false
  retryCount = 0
  autoRefreshed = false
  lastReported = ''
  const binding = bindingGeneration, element = boundVideo, stream = boundStream
  const events: Record<string, () => void> = { loadedmetadata: onLoadedMetadata, canplay: onCanPlay, playing: onPlaying,
    pause: onPause, error: onError, webkitbeginfullscreen: onWebkitBeginFullscreen, webkitendfullscreen: onWebkitEndFullscreen }
  for (const [type, handler] of Object.entries(events)) {
    const listener = () => { if (isBinding(binding, element, stream)) handler() }
    element.addEventListener(type, listener)
    mediaListeners.push({ type, listener })
  }
  for (const type of ['addtrack', 'removetrack']) {
    const listener = () => {
      if (!isBinding(binding, element, stream)) return
      bindTracks()
      if (streamEnded) pauseRendering()
      else if (canPlay()) tryPlay()
    }
    stream.addEventListener(type, listener)
    streamListeners.push({ type, listener })
  }
  bindTracks()
  setStatus(streamEnded ? 'ended' : manualPaused.value || !props.active || !visible() ? 'paused' : 'waiting')
  void nextTick(() => { if (isBinding(binding, element, stream)) tryPlay() })
}

function syncVisibility() {
  if (!mounted || disposed) return
  invalidatePlayback()
  if (canPlay() && browserBlocked) { paused.value = true; setStatus('blocked') }
  else if (canPlay()) tryPlay()
  else pauseRendering()
}
watch(() => props.stream, bind, { flush: 'sync' })
watch(() => props.active, () => {
  fullscreenGeneration++
  fullscreenPending.value = false
  if (!props.active) { fullscreenDesired = false; exitOwnedFullscreen() }
  syncVisibility()
}, { flush: 'sync' })
onMounted(() => {
  mounted = true
  bind()
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('visibilitychange', syncVisibility)
})
onUnmounted(() => {
  disposed = true
  mounted = false
  bindingGeneration++
  fullscreenGeneration++
  fullscreenDesired = false
  exitOwnedFullscreen()
  clearBinding()
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('visibilitychange', syncVisibility)
})

const statusLabel = computed(() => ({ waiting: '正在等待共享画面…', loading: '正在加载共享画面…', playing: '',
  paused: props.active ? '画面已暂停' : '画面未选中，已暂停播放', blocked: '浏览器阻止了自动播放，请点击播放。',
  stalled: '尚未收到可播放画面，正在等待连接恢复。', ended: '共享画面已结束', error: playbackError.value || '共享画面播放出错。' })[status.value])
const playLabel = computed(() => manualPaused.value || status.value === 'blocked' || (paused.value && !playPending.value) ? '播放' : '暂停')
</script>

<template>
  <div ref="containerRef" class="screen-share-player relative bg-black border border-discord-600/50 group"
       :class="isFullscreen ? 'rounded-none' : 'rounded-lg overflow-hidden'">
    <video ref="videoRef" :data-remote-screen="userId" :aria-label="name ? `${name} 的共享画面` : local ? '你的共享画面预览' : '共享画面'"
           muted playsinline class="screen-share-video w-full h-full object-contain" @click="togglePlay" />
    <div v-if="statusLabel" class="screen-playback-status absolute inset-0 flex items-center justify-center pointer-events-none" role="status" aria-live="polite">
      <span class="bg-black/70 text-discord-100 text-sm px-4 py-2 rounded-lg">{{ statusLabel }}</span>
    </div>
    <p v-if="fullscreenError" class="screen-playback-error absolute top-2 left-2 right-2 text-xs text-white bg-black/80 rounded px-3 py-2" role="status">{{ fullscreenError }}</p>
    <div v-if="videoResolution.width > 0" class="absolute top-2 right-2 bg-black/60 text-white text-xs rounded px-2 py-1" aria-hidden="true">
      {{ videoResolution.width }}×{{ videoResolution.height }}
    </div>
    <div class="screen-playback-controls absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2.5 py-2 flex items-center text-xs text-white">
      <button type="button" class="screen-playback-button w-11 h-11 rounded-full bg-white/15 hover:bg-white/30 flex items-center justify-center flex-shrink-0"
              :aria-label="playLabel" :title="playLabel" :disabled="!active || status === 'ended'" @click="togglePlay">
        <svg v-if="playLabel === '播放'" class="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        <svg v-else class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
      </button>
      <div class="flex-1" />
      <button type="button" class="screen-playback-button w-11 h-11 rounded-md bg-white/10 hover:bg-white/25 flex items-center justify-center flex-shrink-0"
              :aria-label="isFullscreen ? '退出全屏' : '全屏'" :title="isFullscreen ? '退出全屏' : '全屏'" :disabled="!active || fullscreenPending" @click="toggleFullscreen">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
      </button>
    </div>
  </div>
</template>
