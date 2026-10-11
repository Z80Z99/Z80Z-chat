<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useVoiceStore } from '../stores/voice'
import { isPushToTalkKey, pushToTalkKeyLabel } from '../utils/push-to-talk'
import DeviceSelect from './DeviceSelect.vue'
import AudioDeviceTest from './AudioDeviceTest.vue'
import VoicePushToTalkButton from './VoicePushToTalkButton.vue'

const props = withDefaults(defineProps<{ stopKey?: string }>(), { stopKey: '' })
const voiceStore = useVoiceStore()
const expanded = ref(true)
const capturingKey = ref(false)
const keyError = ref('')
const keyLabel = computed(() => pushToTalkKeyLabel(voiceStore.pushToTalkKey))
const transmissionLabel = computed(() => {
  if (!voiceStore.currentRoom) return '加入频道后生效'
  if (!voiceStore.micAvailable) return '麦克风不可用'
  if (voiceStore.isDeafened) return '已静音喇叭和麦克风'
  if (voiceStore.isMuted) return '麦克风已静音'
  if (voiceStore.isTransmitting) return '正在发言'
  return voiceStore.voiceMode === 'push-to-talk' ? '等待按住发言' : '尚未连接语音'
})

function startKeyCapture() {
  voiceStore.releasePushToTalk()
  keyError.value = ''
  capturingKey.value = !capturingKey.value
}
function captureKey(event: KeyboardEvent) {
  if (!capturingKey.value) return
  if (event.key === 'Tab') { capturingKey.value = false; return }
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') { capturingKey.value = false; return }
  if (event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isPushToTalkKey(event.code)) {
    keyError.value = '请选择不带组合键的按键，输入法正在选字时无法设置。'
    return
  }
  voiceStore.setPushToTalkKey(event.code)
  capturingKey.value = false
  keyError.value = ''
}
function toggleExpanded() {
  expanded.value = !expanded.value
  if (expanded.value) void voiceStore.refreshDevices()
  else { capturingKey.value = false; voiceStore.releasePushToTalk() }
}
function hidden() { if (document.visibilityState === 'hidden') { capturingKey.value = false; voiceStore.releasePushToTalk() } }
watch([() => props.stopKey, () => voiceStore.currentRoom, () => voiceStore.voiceMode, () => voiceStore.pushToTalkKey], () => {
  capturingKey.value = false
  voiceStore.releasePushToTalk()
}, { flush: 'sync' })
onMounted(() => {
  void voiceStore.refreshDevices()
  document.addEventListener('visibilitychange', hidden)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', hidden)
  voiceStore.releasePushToTalk()
})
</script>

<template>
  <section class="voice-audio-settings bg-discord-800/70 border border-discord-600/50 rounded-xl p-4 text-left" aria-label="音频设置">
    <button type="button" class="voice-settings-toggle w-full flex items-center justify-between text-sm text-discord-100 font-semibold"
            :aria-expanded="expanded" @click="toggleExpanded">
      音频设置
      <span aria-hidden="true" class="text-discord-300">{{ expanded ? '收起' : '展开' }}</span>
    </button>
    <template v-if="expanded">
      <div class="grid md:grid-cols-2 gap-4 mt-3">
        <div class="min-w-0">
          <p class="text-discord-100 text-sm font-medium mb-2">输入设备（麦克风）</p>
          <DeviceSelect :devices="voiceStore.inputDevices" :model-value="voiceStore.inputDeviceId" label="输入设备（麦克风）" @change="voiceStore.changeInputDevice" />
          <label class="voice-master-volume flex items-center gap-2 mt-2">
            <span class="text-discord-200 text-xs shrink-0">输入音量</span>
            <input type="range" min="0" max="200" step="5" aria-label="输入音量" class="min-w-0 w-full accent-green"
                   :value="Math.round(voiceStore.inputVolume * 100)" @input="voiceStore.setInputVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
            <span class="text-discord-200 text-xs w-11 text-right shrink-0">{{ Math.round(voiceStore.inputVolume * 100) }}%</span>
          </label>
        </div>
        <div class="min-w-0">
          <p class="text-discord-100 text-sm font-medium mb-2">输出设备（扬声器）</p>
          <DeviceSelect :devices="voiceStore.outputDevices" :model-value="voiceStore.outputSelectionSupported ? voiceStore.outputDeviceId : ''" label="输出设备（扬声器）"
                        :disabled="!voiceStore.outputSelectionSupported" @change="voiceStore.changeOutputDevice" />
          <p v-if="!voiceStore.outputSelectionSupported" class="text-xs text-discord-300 mt-2">此浏览器使用系统默认输出，耳机和蓝牙请在系统中切换。</p>
          <label class="voice-master-volume flex items-center gap-2 mt-2">
            <span class="text-discord-200 text-xs shrink-0">输出音量</span>
            <input type="range" min="0" max="100" step="5" aria-label="输出音量" class="min-w-0 w-full accent-green"
                   :value="Math.round(voiceStore.outputVolume * 100)" @input="voiceStore.setOutputVolume(Number(($event.target as HTMLInputElement).value) / 100)" />
            <span class="text-discord-200 text-xs w-11 text-right shrink-0">{{ Math.round(voiceStore.outputVolume * 100) }}%</span>
          </label>
        </div>
      </div>
      <div v-if="voiceStore.currentRoom && !voiceStore.micAvailable && voiceStore.micError" class="bg-yellow/10 border border-yellow/30 rounded-lg p-3 mt-3">
        <p class="text-yellow text-sm">{{ voiceStore.micError }}</p>
        <button type="button" class="voice-control-button btn-ghost text-sm mt-2" @click="voiceStore.retryMic()">重新检测麦克风</button>
      </div>
      <div class="voice-mode-settings border-t border-discord-600/50 mt-4 pt-3">
        <label class="voice-mode-row">
          <span class="text-sm font-medium text-discord-100">发言方式</span>
          <select :value="voiceStore.voiceMode" aria-label="发言方式" class="voice-device-select bg-discord-900 border border-discord-600 rounded-lg px-2 text-sm text-discord-100"
                  @change="voiceStore.setVoiceMode(($event.target as HTMLSelectElement).value as 'open' | 'push-to-talk')">
            <option value="open">开放麦克风</option>
            <option value="push-to-talk">按键发言</option>
          </select>
        </label>
        <div v-if="voiceStore.voiceMode === 'push-to-talk'" class="mt-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <span class="text-sm text-discord-200">快捷键：<kbd class="voice-key-label">{{ keyLabel }}</kbd></span>
            <button type="button" class="voice-control-button btn-ghost text-sm" data-ptt-key-capture aria-label="设置按键发言快捷键"
                    :aria-pressed="capturingKey" @click="startKeyCapture" @keydown="captureKey" @blur="capturingKey = false">
              {{ capturingKey ? '请按一个键（Esc 取消）' : '按键设置' }}
            </button>
          </div>
          <p v-if="keyError" role="alert" class="text-xs text-yellow mt-2">{{ keyError }}</p>
          <p class="text-xs text-discord-300 mt-2">网页在前台时按住快捷键说话；输入文字时快捷键不触发。</p>
          <VoicePushToTalkButton v-if="voiceStore.currentRoom" class="mt-3" :stop-key="stopKey" />
        </div>
        <p class="voice-transmission-status text-xs mt-3" :class="voiceStore.isTransmitting ? 'text-green' : 'text-discord-300'" role="status">
          {{ transmissionLabel }}
        </p>
      </div>
      <AudioDeviceTest :input-device-id="voiceStore.inputDeviceId" :output-device-id="voiceStore.outputSelectionSupported ? voiceStore.outputDeviceId : ''"
                       :input-volume="voiceStore.inputVolume" :output-volume="voiceStore.outputVolume"
                       :deafened="voiceStore.isDeafened" :in-call="!!voiceStore.currentRoom" :stop-key="stopKey" @devices-changed="voiceStore.refreshDevices()" />
    </template>
  </section>
</template>
