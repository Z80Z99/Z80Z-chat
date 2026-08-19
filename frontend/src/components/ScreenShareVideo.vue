<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps<{ userId: string; stream: MediaStream }>()
const emit = defineEmits<{ (e: 'refresh'): void }>()

const containerRef = ref<HTMLDivElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
  const status = ref<'waiting' | 'loading' | 'playing' | 'black' | 'error'>('waiting')
  const fps = ref(0)
  const paused = ref(true)
  const isFullscreen = ref(false)
  const displayMode = ref<'contain' | 'fill' | 'cover'>('contain')
  let prevDisplayMode: 'contain' | 'fill' | 'cover' = 'contain'
  const videoResolution = ref({ width: 0, height: 0 })

let rafToken: number | null = null
let checkTimer: any = null
let lastFrameAt = 0
let blackSince = 0
let autoRefreshed = false
let frameTick = 0
let lastSec = 0
let lastCurrentTime = -1
let playRetry = 0
const PLAY_RETRY_MAX = 5

function setStatus(s: typeof status.value) {
  if (status.value !== s) status.value = s
}

function tryPlay() {
  const el = videoRef.value
  if (!el || !el.srcObject) return
  const p = el.play()
  if (p) {
    p.then(() => {
      playRetry = 0
      paused.value = false
    }).catch(() => {
      // 远程轨道首帧未就绪时 play() 会 reject：延迟自动重试，避免卡在"点击播放"
      if (playRetry < PLAY_RETRY_MAX) {
        playRetry++
        setTimeout(tryPlay, 500)
      } else {
        paused.value = true
        if (status.value === 'black' || status.value === 'error') return
        setStatus('waiting')
      }
    })
  }
}

function togglePlay() {
  const el = videoRef.value
  if (!el) return
  if (el.paused) {
    tryPlay()
  } else {
    el.pause()
    paused.value = true
  }
}

  function onLoadedMetadata() {
    setStatus('loading')
    const el = videoRef.value
    if (el) {
      videoResolution.value = {
        width: el.videoWidth,
        height: el.videoHeight
      }
    }
    tryPlay()
  }

function onCanPlay() {
  tryPlay()
}

function onPlaying() {
  lastFrameAt = Date.now()
  paused.value = false
  setStatus('playing')
}

function onPause() {
  paused.value = true
}

function onError() {
  setStatus('error')
}

function onFrame() {
  frameTick++
  lastFrameAt = Date.now()
  const el = videoRef.value
  if (el && typeof el.requestVideoFrameCallback === 'function') {
    rafToken = el.requestVideoFrameCallback(onFrame)
  }
}

function stopFrameDetection() {
  if (rafToken !== null && videoRef.value && typeof videoRef.value.cancelVideoFrameCallback === 'function') {
    videoRef.value.cancelVideoFrameCallback(rafToken)
  }
  rafToken = null
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}

function startFrameDetection() {
  stopFrameDetection()
  const el = videoRef.value
  if (!el) return
  frameTick = 0
  fps.value = 0
  if (typeof el.requestVideoFrameCallback === 'function') {
    rafToken = el.requestVideoFrameCallback(onFrame)
  }
  checkTimer = setInterval(() => {
    const now = Date.now()
    if (!el.paused) {
      if (el.currentTime > 0 && el.currentTime !== lastCurrentTime) {
        lastCurrentTime = el.currentTime
        lastFrameAt = now
        if (lastSec === 0) lastSec = now
        frameTick++
        if (now - lastSec >= 1000) {
          fps.value = Math.round((frameTick * 1000) / (now - lastSec))
          frameTick = 0
          lastSec = now
        }
      }
      if (status.value === 'playing' && now - lastFrameAt > 3000) {
        if (blackSince === 0) blackSince = now
        if (now - blackSince >= 2000) {
          setStatus('black')
          if (!autoRefreshed) {
            autoRefreshed = true
            emit('refresh')
          }
        }
      } else if (blackSince > 0 && now - lastFrameAt <= 3000) {
        blackSince = 0
      }
    }
  }, 1000)
}

function bind() {
  const el = videoRef.value
  if (!el) return
  if (el.srcObject !== props.stream) {
    el.srcObject = props.stream
    autoRefreshed = false
    blackSince = 0
    playRetry = 0
    setStatus('waiting')
  }
  startFrameDetection()
  nextTick(() => tryPlay())
}

  function enterVideoFullscreen() {
    const v = videoRef.value as any
    if (!v) return
    if (typeof v.requestFullscreen === 'function') {
      prevDisplayMode = displayMode.value
      displayMode.value = 'cover'
      v.requestFullscreen().then(() => {
        isFullscreen.value = true
      }).catch(() => {
        if (typeof v.webkitEnterFullscreen === 'function') {
          v.webkitEnterFullscreen()
          isFullscreen.value = true
        } else {
          displayMode.value = prevDisplayMode
        }
      })
    } else if (typeof v.webkitEnterFullscreen === 'function') {
      prevDisplayMode = displayMode.value
      displayMode.value = 'cover'
      v.webkitEnterFullscreen()
      isFullscreen.value = true
    }
  }

  function toggleFullscreen() {
    const container = containerRef.value
    const video = videoRef.value as any
    const inNativeFs = !!(video && video.webkitDisplayingFullscreen)
    if (document.fullscreenElement || inNativeFs) {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {})
      } else if (video && typeof video.webkitExitFullscreen === 'function') {
        video.webkitExitFullscreen()
      }
    } else {
      if (container && typeof container.requestFullscreen === 'function') {
        prevDisplayMode = displayMode.value
        displayMode.value = 'cover'
        container.requestFullscreen().then(() => {
          isFullscreen.value = true
        }).catch(() => {
          displayMode.value = prevDisplayMode
          enterVideoFullscreen()
        })
      } else {
        enterVideoFullscreen()
      }
    }
  }

  onMounted(() => {
  bind()
  document.addEventListener('fullscreenchange', onFsChange)
  const v = videoRef.value as any
  if (v) {
    v.addEventListener('webkitbeginfullscreen', onWebkitBeginFullscreen)
    v.addEventListener('webkitendfullscreen', onWebkitEndFullscreen)
  }
})

onUnmounted(() => {
  stopFrameDetection()
  document.removeEventListener('fullscreenchange', onFsChange)
  const v = videoRef.value as any
  if (v) {
    v.removeEventListener('webkitbeginfullscreen', onWebkitBeginFullscreen)
    v.removeEventListener('webkitendfullscreen', onWebkitEndFullscreen)
  }
})

function onFsChange() {
  const fs = !!document.fullscreenElement
  isFullscreen.value = fs
  if (!fs) displayMode.value = prevDisplayMode
}

function onWebkitBeginFullscreen() {
  isFullscreen.value = true
}

function onWebkitEndFullscreen() {
  isFullscreen.value = false
  displayMode.value = prevDisplayMode
}

watch(() => props.stream, () => {
  bind()
})
</script>

<template>
  <div ref="containerRef" :class="[
    'relative bg-black border border-discord-600/50 group',
    isFullscreen ? 'rounded-none' : 'rounded-lg overflow-hidden'
  ]">
  <video ref="videoRef" :data-remote-screen="userId"
         autoplay muted playsinline
         :style="{ objectFit: displayMode }"
         :class="[
           isFullscreen ? 'w-full h-full' : 'w-full h-auto max-h-[70vh]'
         ]"
         @loadedmetadata="onLoadedMetadata"
         @canplay="onCanPlay"
         @playing="onPlaying"
         @pause="onPause"
         @error="onError"
         @click="togglePlay"></video>

    <div v-if="status === 'waiting' || status === 'loading'"
         class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="flex items-center gap-2 bg-black/60 backdrop-blur-sm text-discord-100 text-sm px-4 py-2 rounded-full border border-discord-600/50">
        <svg v-if="status === 'loading'" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <svg v-else class="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <span>{{ status === 'loading' ? '加载中…' : '点击播放' }}</span>
      </div>
    </div>

    <div v-if="status === 'black'"
         class="absolute top-2 left-2 right-2 z-10">
      <div class="bg-red/95 text-white text-xs px-3 py-2 rounded-lg flex items-center justify-between gap-2 shadow-lg">
        <span class="flex items-center gap-1.5">
          <svg class="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          画面黑屏（数据正常）— 已尝试刷新，可手动重试
        </span>
        <button @click="emit('refresh')"
                class="bg-white/20 hover:bg-white/30 rounded-md px-2.5 py-1 font-medium flex-shrink-0">
          刷新画面
        </button>
      </div>
    </div>

    <!-- 分辨率标识 -->
    <div v-if="videoResolution.width > 0" 
         class="absolute top-2 right-2 z-10 bg-black/60 text-white text-xs rounded px-2 py-1">
      {{ videoResolution.width }}×{{ videoResolution.height }}
    </div>

    <div class="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2.5 py-2 flex items-center text-xs text-white">
      <button @click="togglePlay"
              class="w-7 h-7 rounded-full bg-white/15 hover:bg-white/30 flex items-center justify-center flex-shrink-0"
              :title="paused ? '播放' : '暂停'">
        <svg v-if="paused" class="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <svg v-else class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M6 5h4v14H6zM14 5h4v14h-4z"/>
        </svg>
      </button>
      <div class="flex-1"></div>
      <div v-if="isFullscreen" class="flex items-center gap-0.5 bg-black/40 rounded-md p-0.5 mr-1">
        <button @click="displayMode = 'contain'"
                :class="displayMode === 'contain' ? 'bg-white/30 text-white' : 'text-white/60 hover:text-white'"
                class="text-[11px] px-2 py-1 rounded transition-colors"
                title="保持比例，可能有黑边">保持比例</button>
        <button @click="displayMode = 'cover'"
                :class="displayMode === 'cover' ? 'bg-white/30 text-white' : 'text-white/60 hover:text-white'"
                class="text-[11px] px-2 py-1 rounded transition-colors"
                title="填满屏幕，裁剪边缘">填满屏幕</button>
        <button @click="displayMode = 'fill'"
                :class="displayMode === 'fill' ? 'bg-white/30 text-white' : 'text-white/60 hover:text-white'"
                class="text-[11px] px-2 py-1 rounded transition-colors"
                title="拉伸填满，可能会变形">拉伸填满</button>
      </div>
      <button @click="toggleFullscreen"
              class="w-7 h-7 rounded-md bg-white/10 hover:bg-white/25 flex items-center justify-center flex-shrink-0"
              title="全屏">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
        </svg>
      </button>
    </div>
  </div>
</template>
