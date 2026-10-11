<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useVoiceStore } from '../stores/voice'
const props = withDefaults(defineProps<{ stopKey?: string }>(), { stopKey: '' })
const voiceStore = useVoiceStore()
let pointerId: number | null = null
let heldButton: HTMLButtonElement | null = null
const canHold = computed(() => Boolean(voiceStore.currentRoom && voiceStore.voiceMode === 'push-to-talk' && voiceStore.micAvailable && !voiceStore.isMuted && !voiceStore.isDeafened))

function releasePointer() {
  const button = heldButton, id = pointerId
  pointerId = null
  heldButton = null
  voiceStore.releasePushToTalk()
  if (button && id !== null) {
    try { if (button.hasPointerCapture(id)) button.releasePointerCapture(id) } catch {}
  }
}
function hold(event: PointerEvent) {
  if (!canHold.value || pointerId !== null || event.button !== 0 || !event.isPrimary) return
  event.preventDefault()
  pointerId = event.pointerId
  heldButton = event.currentTarget as HTMLButtonElement
  try { heldButton.setPointerCapture(event.pointerId) } catch {}
  voiceStore.setPushToTalkPressed(true)
}
function pointerEnded(event: PointerEvent) { if (pointerId === event.pointerId) releasePointer() }
function hidden() { if (document.visibilityState === 'hidden') releasePointer() }
watch([() => props.stopKey, () => voiceStore.currentRoom, () => voiceStore.voiceMode, () => voiceStore.pushToTalkKey, canHold], releasePointer, { flush: 'sync' })
watch(() => voiceStore.pushToTalkPressed, pressed => { if (!pressed && pointerId !== null) releasePointer() }, { flush: 'sync' })
onMounted(() => {
  window.addEventListener('blur', releasePointer)
  window.addEventListener('pointerup', pointerEnded)
  window.addEventListener('pointercancel', pointerEnded)
  document.addEventListener('visibilitychange', hidden)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', releasePointer)
  window.removeEventListener('pointerup', pointerEnded)
  window.removeEventListener('pointercancel', pointerEnded)
  document.removeEventListener('visibilitychange', hidden)
  releasePointer()
})
</script>

<template>
  <button type="button" class="voice-ptt-hold" aria-label="按住说话"
          :aria-pressed="voiceStore.pushToTalkPressed" :disabled="!canHold"
          @pointerdown="hold" @pointerup="pointerEnded" @pointercancel="pointerEnded" @lostpointercapture="pointerEnded">
    {{ voiceStore.isTransmitting ? '松开停止发言' : '按住说话' }}
  </button>
</template>
