<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { createAudioDeviceTest, type AudioTestState } from '../utils/audio-device-test'

const props = withDefaults(defineProps<{
  inputDeviceId: string
  outputDeviceId: string
  inputVolume: number
  outputVolume: number
  deafened?: boolean
  inCall?: boolean
  stopKey?: string
}>(), { deafened: false, inCall: false, stopKey: '' })
const emit = defineEmits<{ (event: 'devices-changed'): void }>()
const state = ref<AudioTestState>({ kind: null, status: 'idle', level: 0, error: '' })
const tester = createAudioDeviceTest(props, value => { state.value = value })
const active = computed(() => state.value.status === 'starting' || state.value.status === 'running')
const levelPercent = computed(() => Math.round(state.value.level * 100))
const statusText = computed(() => {
  if (state.value.status === 'error') return state.value.error
  if (state.value.status === 'starting') return state.value.kind === 'microphone' ? '正在等待麦克风权限…' : '正在准备测试音…'
  if (state.value.status === 'running') return state.value.kind === 'microphone' ? '正在检测麦克风，请说话。' : '正在播放测试音，将自动停止。'
  return '测试尚未开始。'
})

async function testMicrophone() {
  await tester.startMicrophone()
  if (state.value.kind === 'microphone' && state.value.status === 'running') emit('devices-changed')
}

watch(() => [props.inputDeviceId, props.outputDeviceId, props.inputVolume, props.outputVolume, props.deafened] as const,
  () => tester.update(props), { flush: 'sync' })
watch(() => props.stopKey, () => tester.stop(), { flush: 'sync' })
onUnmounted(() => tester.dispose())
defineExpose({ stop: tester.stop })
</script>

<template>
  <section class="audio-device-test" aria-label="本地音频设备测试">
    <div class="audio-device-test-heading">设备测试</div>
    <p class="audio-device-test-description">测试链路仅在本机运行，不会加入语音频道。麦克风电平不会回放声音。</p>
    <p v-if="inCall" class="audio-device-test-description">通话期间，发言仍按当前发言方式发送；需要安静测试时请先静音。</p>
    <div class="audio-device-test-actions">
      <button type="button" class="audio-device-test-button" data-audio-test="microphone" :disabled="active" @click="testMicrophone">
        测试麦克风
      </button>
      <button type="button" class="audio-device-test-button" data-audio-test="speaker" :disabled="active || deafened" @click="tester.startSpeaker()">
        播放测试音
      </button>
      <button v-if="active" type="button" class="audio-device-test-button audio-device-test-stop" data-audio-test="stop" @click="tester.stop()">
        停止测试
      </button>
    </div>
    <p v-if="deafened" class="audio-device-test-description">已关闭声音，取消耳机静音后可测试扬声器。</p>
    <p v-else-if="outputVolume <= 0" class="audio-device-test-description">输出音量为 0，测试音将不可听。</p>
    <div class="audio-device-test-meter" role="meter" aria-label="麦克风输入电平" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="levelPercent" :aria-valuetext="`${levelPercent}%`">
      <div class="audio-device-test-meter-fill" :style="{ width: `${levelPercent}%` }" />
    </div>
    <p class="audio-device-test-status" :class="{ 'audio-device-test-error': state.status === 'error' }" role="status" aria-live="polite" aria-atomic="true">{{ statusText }}</p>
  </section>
</template>
