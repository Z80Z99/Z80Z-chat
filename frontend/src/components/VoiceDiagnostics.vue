<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useVoiceStore } from '../stores/voice'
import { diagnosticState, diagnosticValue } from '../utils/voice-diagnostics'

const props = defineProps<{ names?: Record<string, string> }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const voiceStore = useVoiceStore()
const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const peers = computed(() => Object.values(voiceStore.peerDiagnostics))
const previousFocus = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null
let disposed = false

function memberName(userId: string) { return props.names?.[userId] || '语音成员' }
function resolution(width: number | null | undefined, height: number | null | undefined) {
  return width === null || width === undefined || height === null || height === undefined ? '未提供' : `${width} × ${height}`
}
function candidateType(type: string | null) {
  const names: Record<string, string> = { host: '本地', srflx: '公网映射', prflx: '对端映射', relay: '中继' }
  return type && Object.prototype.hasOwnProperty.call(names, type) ? names[type] : '未提供'
}
function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab' || !panelRef.value) return
  const controls = Array.from(panelRef.value.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.getAttribute('aria-hidden') !== 'true' && !element.hidden)
  const first = controls[0], last = controls[controls.length - 1]
  if (!first) { event.preventDefault(); panelRef.value.focus(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

onMounted(async () => {
  voiceStore.releasePushToTalk()
  voiceStore.setDiagnosticsEnabled(true)
  await nextTick()
  if (!disposed) closeRef.value?.focus()
})
onUnmounted(() => {
  disposed = true
  voiceStore.setDiagnosticsEnabled(false)
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <div class="voice-diagnostics-backdrop" @click.self="emit('close')">
    <section id="voice-diagnostics" ref="panelRef" class="voice-diagnostics-panel" role="dialog" aria-modal="true" aria-labelledby="voice-diagnostics-title" tabindex="-1" @keydown="handleKeydown">
      <header class="voice-diagnostics-header">
        <div>
          <h2 id="voice-diagnostics-title">连接诊断</h2>
          <p>每 2 秒更新。浏览器缺少的统计显示为“未提供”。</p>
        </div>
        <button ref="closeRef" type="button" class="voice-diagnostics-close" aria-label="关闭连接诊断" @click="emit('close')">×</button>
      </header>
      <div class="voice-diagnostics-content">
        <p v-if="!voiceStore.currentRoom" class="voice-diagnostics-empty">加入语音频道后可查看连接。</p>
        <p v-else-if="!peers.length" class="voice-diagnostics-empty">当前没有其他成员的连接。</p>
        <article v-for="peer in peers" :key="peer.userId" class="voice-diagnostics-peer">
          <header class="voice-diagnostics-peer-header">
            <h3>{{ memberName(peer.userId) }}</h3>
            <span>{{ peer.error ? '暂不可用' : peer.sampledAt === null ? '等待采集' : '已采集' }}</span>
          </header>
          <p v-if="peer.error" class="voice-diagnostics-error" role="status">{{ peer.error }}</p>
          <dl class="voice-diagnostics-grid">
            <div><dt>连接</dt><dd>{{ diagnosticState(peer.connectionState) }}</dd></div>
            <div><dt>ICE</dt><dd>{{ diagnosticState(peer.iceConnectionState) }}</dd></div>
            <div><dt>往返延迟</dt><dd>{{ diagnosticValue(peer.rttMs, ' ms') }}</dd></div>
            <div><dt>传输协议</dt><dd>{{ peer.selectedCandidate.protocol?.toUpperCase() || '未提供' }}</dd></div>
            <div><dt>本地通路</dt><dd>{{ candidateType(peer.selectedCandidate.localType) }}</dd></div>
            <div><dt>对端通路</dt><dd>{{ candidateType(peer.selectedCandidate.remoteType) }}</dd></div>
          </dl>
          <div class="voice-diagnostics-table-wrap">
            <table class="voice-diagnostics-table">
              <caption>媒体传输</caption>
              <thead><tr><th scope="col">方向</th><th scope="col">码率</th><th scope="col">丢包</th></tr></thead>
              <tbody>
                <tr><th scope="row">语音接收</th><td>{{ diagnosticValue(peer.audioIn.bitrateKbps, ' kbps') }}</td><td>{{ diagnosticValue(peer.audioIn.lossPercent, '%', 1) }}</td></tr>
                <tr><th scope="row">语音发送</th><td>{{ diagnosticValue(peer.audioOut.bitrateKbps, ' kbps') }}</td><td>{{ diagnosticValue(peer.audioOut.lossPercent, '%', 1) }}</td></tr>
                <tr><th scope="row">视频接收</th><td>{{ diagnosticValue(peer.videoIn.bitrateKbps, ' kbps') }}</td><td>{{ diagnosticValue(peer.videoIn.lossPercent, '%', 1) }}</td></tr>
                <tr><th scope="row">视频发送</th><td>{{ diagnosticValue(peer.videoOut.bitrateKbps, ' kbps') }}</td><td>{{ diagnosticValue(peer.videoOut.lossPercent, '%', 1) }}</td></tr>
              </tbody>
            </table>
          </div>
          <h4 class="voice-diagnostics-subtitle">视频接收与解码</h4>
          <dl class="voice-diagnostics-grid">
            <div><dt>收到帧数</dt><dd>{{ diagnosticValue(peer.videoIn.framesReceived) }}</dd></div>
            <div><dt>解码帧数</dt><dd>{{ diagnosticValue(peer.videoIn.framesDecoded) }}</dd></div>
            <div><dt>接收分辨率</dt><dd>{{ resolution(peer.videoIn.width, peer.videoIn.height) }}</dd></div>
            <div><dt>接收帧率</dt><dd>{{ diagnosticValue(peer.videoIn.fps, ' fps', 1) }}</dd></div>
          </dl>
          <h4 class="voice-diagnostics-subtitle">播放器呈现</h4>
          <p v-if="!peer.playback" class="voice-diagnostics-note">尚未挂载此成员的投屏播放器。</p>
          <dl v-else class="voice-diagnostics-grid">
            <div><dt>播放器状态</dt><dd>{{ diagnosticState(peer.playback.status) }}</dd></div>
            <div><dt>呈现帧数</dt><dd>{{ diagnosticValue(peer.playback.framesPresented) }}</dd></div>
            <div><dt>播放分辨率</dt><dd>{{ resolution(peer.playback.width, peer.playback.height) }}</dd></div>
            <div><dt>呈现帧率</dt><dd>{{ diagnosticValue(peer.playback.fps, ' fps', 1) }}</dd></div>
          </dl>
        </article>
      </div>
      <footer class="voice-diagnostics-footer">网络收到视频、完成解码和播放器呈现是不同阶段。这里不显示地址或会话内容。</footer>
    </section>
  </div>
</template>
