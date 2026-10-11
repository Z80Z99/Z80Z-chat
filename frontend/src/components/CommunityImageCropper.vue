<script setup lang="ts">
import { ref, shallowRef, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { decodeCommunityImage, drawCommunityImage, exportCommunityImage } from '../utils/community-image'
import type { CommunityImage, CommunityImageKind } from '../utils/community-image'

const props = defineProps<{ file: File; kind: CommunityImageKind; sessionKey: string }>()
const emit = defineEmits<{ close: []; confirm: [file: File] }>()
const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const image = shallowRef<CommunityImage | null>(null)
const zoom = ref(1)
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
let generation = 0
let mounted = true
let opener: HTMLElement | null = null
let decodeController: AbortController | null = null

function releaseImage() { image.value?.dispose(); image.value = null }

watch(() => [props.file, props.kind, props.sessionKey], async () => {
  const version = ++generation
  decodeController?.abort()
  const controller = new AbortController()
  decodeController = controller
  releaseImage(); zoom.value = 1; error.value = ''; loading.value = true; exporting.value = false
  try {
    const decoded = await decodeCommunityImage(props.file, props.kind, controller.signal)
    if (!mounted || version !== generation) { decoded.dispose(); return }
    image.value = decoded
    await nextTick()
    if (mounted && version === generation) drawPreview()
  } catch (e: any) {
    if (mounted && version === generation) error.value = e.message || '无法读取这张图片'
  } finally { if (mounted && version === generation) loading.value = false }
}, { immediate: true })

function drawPreview() {
  if (!canvasRef.value || !image.value) return
  try { drawCommunityImage(canvasRef.value, image.value, props.kind, zoom.value) }
  catch (e: any) { error.value = e.message || '无法预览图片' }
}
watch([zoom, canvasRef], drawPreview)

async function confirmCrop() {
  if (!image.value || loading.value || exporting.value) return
  const version = generation
  const current = image.value
  exporting.value = true; error.value = ''
  try {
    const file = await exportCommunityImage(current, props.kind, zoom.value)
    if (mounted && version === generation && current === image.value) emit('confirm', file)
  } catch (e: any) {
    if (mounted && version === generation) error.value = e.message || '裁切失败，请重试'
  } finally { if (mounted && version === generation) exporting.value = false }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); emit('close'); return
  }
  if (event.key !== 'Tab' || !dialogRef.value) return
  const controls = [...dialogRef.value.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')]
    .filter(element => !element.hasAttribute('disabled') && !element.hidden)
  const first = controls[0], last = controls[controls.length - 1]
  if (!first) { event.preventDefault(); dialogRef.value.focus(); return }
  if (!dialogRef.value.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus()
  } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (mounted) cancelRef.value?.focus()
})
onBeforeUnmount(() => {
  mounted = false; ++generation; decodeController?.abort(); decodeController = null; releaseImage()
  if (opener?.isConnected) opener.focus()
})
</script>

<template>
  <div class="modal-overlay community-crop-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <section ref="dialogRef" class="community-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="community-crop-title" tabindex="-1">
      <header class="community-section-header">
        <h2 id="community-crop-title">裁切{{ kind === 'avatar' ? '头像' : '横幅' }}</h2>
        <button ref="cancelRef" type="button" class="community-icon-button" aria-label="取消图片裁切" @click="emit('close')">×</button>
      </header>
      <p class="community-muted">拖动缩放条调整中心裁切范围，确认后预览，保存修改时上传。</p>
      <div class="community-crop-preview" :class="{ 'community-crop-avatar': kind === 'avatar' }">
        <canvas ref="canvasRef" :width="kind === 'avatar' ? 256 : 800" :height="kind === 'avatar' ? 256 : 200" aria-label="裁切图片预览"></canvas>
        <p v-if="loading" role="status">正在读取图片…</p>
      </div>
      <label class="community-field community-zoom-field">
        <span>缩放 <output>{{ Number(zoom).toFixed(1) }} 倍</output></span>
        <input v-model.number="zoom" type="range" min="1" max="3" step="0.05" aria-label="图片缩放" :disabled="loading || exporting || !image" />
      </label>
      <p v-if="error" class="community-error" role="alert">{{ error }}</p>
      <footer class="community-form-actions">
        <button type="button" class="btn-ghost" @click="emit('close')">取消</button>
        <button type="button" class="btn-primary" :disabled="loading || exporting || !image" @click="confirmCrop">{{ exporting ? '处理中…' : '确认裁切' }}</button>
      </footer>
    </section>
  </div>
</template>
