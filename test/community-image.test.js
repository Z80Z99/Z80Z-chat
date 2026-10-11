import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCommunityImage, validateCommunityDimensions, communityCropRect, decodeCommunityImage, exportCommunityImage } from '../frontend/src/utils/community-image.ts'

test('社区图片只接受PNG/JPEG/WebP，并按头像和横幅限制大小', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) validateCommunityImage({ type, size: 2 * 1024 * 1024 }, 'avatar')
  assert.throws(() => validateCommunityImage({ type: 'image/gif', size: 20 }, 'avatar'), /PNG/)
  assert.throws(() => validateCommunityImage({ type: 'image/svg+xml', size: 20 }, 'banner'), /PNG/)
  assert.throws(() => validateCommunityImage({ type: 'image/png', size: 0 }, 'avatar'), /2 MB/)
  assert.throws(() => validateCommunityImage({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }, 'avatar'), /2 MB/)
  validateCommunityImage({ type: 'image/png', size: 5 * 1024 * 1024 }, 'banner')
  assert.throws(() => validateCommunityImage({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }, 'banner'), /5 MB/)
})

test('中心裁切覆盖正方形及4:1横幅，缩放保持中心且限制范围', () => {
  assert.deepEqual(communityCropRect(1000, 600, 'avatar', 1), { x: 200, y: 0, width: 600, height: 600 })
  assert.deepEqual(communityCropRect(1000, 600, 'banner', 1), { x: 0, y: 175, width: 1000, height: 250 })
  assert.deepEqual(communityCropRect(600, 1000, 'banner', 2), { x: 150, y: 462.5, width: 300, height: 75 })
  assert.deepEqual(communityCropRect(900, 900, 'avatar', 20), { x: 300, y: 300, width: 300, height: 300 })
  assert.deepEqual(communityCropRect(900, 900, 'avatar', NaN), { x: 0, y: 0, width: 900, height: 900 })
  validateCommunityDimensions(4096, 4096)
  for (const [width, height] of [[4097, 1], [1, 4097], [0, 20], [20, NaN], [1.5, 2]]) assert.throws(() => validateCommunityDimensions(width, height))
})

test('解码校验尺寸，失败及正常释放关闭bitmap一次，不支持的文件不解码', async t => {
  const original = globalThis.createImageBitmap
  t.after(() => { if (original === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = original })
  let closes = 0, decodes = 0
  const bitmap = { width: 1000, height: 600, close() { closes++ } }
  globalThis.createImageBitmap = async () => { decodes++; return bitmap }
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  const image = await decodeCommunityImage(file, 'banner')
  assert.equal(image.source, bitmap)
  assert.equal(image.width, 1000)
  image.dispose(); image.dispose()
  assert.equal(closes, 1)
  bitmap.width = 4097
  await assert.rejects(decodeCommunityImage(file, 'banner'), /4096/)
  assert.equal(closes, 2)
  await assert.rejects(decodeCommunityImage(new File(['gif'], 'a.gif', { type: 'image/gif' }), 'avatar'), /PNG/)
  assert.equal(decodes, 2)
  globalThis.createImageBitmap = async () => { throw new Error('decode internals') }
  await assert.rejects(decodeCommunityImage(file, 'banner'), /无法读取/)
})

test('裁切输出固定尺寸和中心源区域，使用实际blob格式而非虚假扩展名', async t => {
  const original = globalThis.document
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original })
  const drawn = [], canvases = []
  let outputType = 'image/webp', output = 'result'
  globalThis.document = { createElement(tag) {
    assert.equal(tag, 'canvas')
    const canvas = { width: 0, height: 0,
      getContext() { return { clearRect() {}, drawImage(...args) { drawn.push(args) } } },
      toBlob(callback, type, quality) { assert.equal(type, 'image/webp'); assert.equal(quality, 0.9); callback(new Blob([output], { type: outputType })) }
    }
    canvases.push(canvas); return canvas
  } }
  const image = { source: { id: 'source' }, width: 1000, height: 600, dispose() {} }
  const avatar = await exportCommunityImage(image, 'avatar', 2)
  assert.deepEqual([canvases[0].width, canvases[0].height], [256, 256])
  assert.deepEqual(drawn[0], [image.source, 350, 150, 300, 300, 0, 0, 256, 256])
  assert.equal(avatar.name, 'community-avatar.webp')
  assert.equal(avatar.type, 'image/webp')
  outputType = 'image/png'
  const banner = await exportCommunityImage(image, 'banner', 1)
  assert.deepEqual([canvases[1].width, canvases[1].height], [1600, 400])
  assert.equal(banner.name, 'community-banner.png')
  output = ''
  await assert.rejects(exportCommunityImage(image, 'banner', 1), /裁切失败/)
  output = 'x'.repeat(5 * 1024 * 1024 + 1)
  await assert.rejects(exportCommunityImage(image, 'banner', 1), /过大/)
})

test('Image回退解码在成功和失败后都释放objectURL，不保留事件处理器', async t => {
  const originalBitmap = globalThis.createImageBitmap, originalImage = globalThis.Image
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL
  t.after(() => {
    if (originalBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originalBitmap
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage
    URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL
  })
  delete globalThis.createImageBitmap
  const revoked = [], images = []
  let fail = false
  URL.createObjectURL = () => 'blob:image'
  URL.revokeObjectURL = url => revoked.push(url)
  globalThis.Image = class {
    naturalWidth = 600; naturalHeight = 500
    constructor() { images.push(this) }
    set src(value) { this.value = value; if (value) queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()) }
  }
  const file = new File(['image'], 'a.png', { type: 'image/png' })
  const image = await decodeCommunityImage(file, 'avatar')
  assert.deepEqual(revoked, [])
  image.dispose(); image.dispose()
  assert.deepEqual(revoked, ['blob:image'])
  assert.equal(images[0].onload, null)
  assert.equal(images[0].value, '')
  fail = true
  await assert.rejects(decodeCommunityImage(file, 'banner'), /无法读取/)
  assert.deepEqual(revoked, ['blob:image', 'blob:image'])
  assert.equal(images[1].onerror, null)
})

test('取消未完成解码立即释放Image objectURL，迟到bitmap完成后关闭不交给调用者', async t => {
  const originalBitmap = globalThis.createImageBitmap, originalImage = globalThis.Image
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL
  t.after(() => {
    if (originalBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originalBitmap
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage
    URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL
  })
  delete globalThis.createImageBitmap
  const revoked = [], images = []
  URL.createObjectURL = () => 'blob:pending'
  URL.revokeObjectURL = url => revoked.push(url)
  globalThis.Image = class {
    constructor() { images.push(this) }
    set src(value) { this.value = value }
  }
  const file = new File(['image'], 'a.png', { type: 'image/png' }), controller = new AbortController()
  const pending = decodeCommunityImage(file, 'avatar', controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.deepEqual(revoked, ['blob:pending'])
  assert.equal(images[0].onload, null)
  assert.equal(images[0].value, '')
  let resolve, closed = 0
  globalThis.createImageBitmap = () => new Promise(callback => { resolve = callback })
  const bitmapController = new AbortController()
  const bitmapPending = decodeCommunityImage(file, 'banner', bitmapController.signal)
  bitmapController.abort()
  resolve({ width: 20, height: 20, close() { closed++ } })
  await assert.rejects(bitmapPending, error => error.name === 'AbortError')
  assert.equal(closed, 1)
})
