export type CommunityImageKind = 'avatar' | 'banner'

export interface CommunityImage {
  source: CanvasImageSource
  width: number
  height: number
  dispose(): void
}

const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
export const communityImageLimit = (kind: CommunityImageKind) => (kind === 'avatar' ? 2 : 5) * 1024 * 1024

export function validateCommunityImage(file: Pick<File, 'size' | 'type'>, kind: CommunityImageKind) {
  if (!supportedTypes.has(file.type.toLowerCase())) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
  if (file.size <= 0 || file.size > communityImageLimit(kind)) {
    throw new Error(`${kind === 'avatar' ? '头像' : '横幅'}图片不能超过 ${kind === 'avatar' ? 2 : 5} MB`)
  }
}

export function validateCommunityDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('图片尺寸无效')
  if (width > 4096 || height > 4096) throw new Error('图片宽度和高度不能超过 4096 像素')
}

export async function decodeCommunityImage(file: File, kind: CommunityImageKind, signal?: AbortSignal): Promise<CommunityImage> {
  validateCommunityImage(file, kind)
  const cancelled = () => new DOMException('图片读取已取消', 'AbortError')
  if (signal?.aborted) throw cancelled()
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap
    try { bitmap = await createImageBitmap(file) } catch { throw new Error('无法读取这张图片，请选择其他图片') }
    if (signal?.aborted) { bitmap.close(); throw cancelled() }
    try { validateCommunityDimensions(bitmap.width, bitmap.height) } catch (error) { bitmap.close(); throw error }
    let disposed = false
    return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose() { if (!disposed) { disposed = true; bitmap.close() } } }
  }
  const url = URL.createObjectURL(file)
  const image = new Image()
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(cancelled())
      signal?.addEventListener('abort', abort, { once: true })
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('无法读取这张图片，请选择其他图片'))
      image.src = url
    })
    if (signal?.aborted) throw cancelled()
    validateCommunityDimensions(image.naturalWidth, image.naturalHeight)
    let disposed = false
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, dispose() {
      if (disposed) return
      disposed = true; image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(url)
    } }
  } catch (error) {
    image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(url)
    throw error
  } finally { if (abort) signal?.removeEventListener('abort', abort) }
}

export function communityCropRect(width: number, height: number, kind: CommunityImageKind, zoom = 1) {
  validateCommunityDimensions(width, height)
  const safeZoom = Number.isFinite(zoom) ? Math.max(1, Math.min(3, zoom)) : 1
  const ratio = kind === 'avatar' ? 1 : 4
  const cropWidth = Math.min(width, height * ratio) / safeZoom
  const cropHeight = cropWidth / ratio
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight }
}

export function drawCommunityImage(canvas: HTMLCanvasElement, image: CommunityImage, kind: CommunityImageKind, zoom: number) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法裁切图片')
  const rect = communityCropRect(image.width, image.height, kind, zoom)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image.source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
}

export async function exportCommunityImage(image: CommunityImage, kind: CommunityImageKind, zoom: number): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = kind === 'avatar' ? 256 : 1600
  canvas.height = kind === 'avatar' ? 256 : 400
  drawCommunityImage(canvas, image, kind, zoom)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
  if (!blob || blob.size === 0 || !['image/webp', 'image/png'].includes(blob.type)) throw new Error('图片裁切失败，请重试')
  if (blob.size > communityImageLimit(kind)) throw new Error('裁切后的图片过大，请选择其他图片')
  return new File([blob], `community-${kind}.${blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type })
}
