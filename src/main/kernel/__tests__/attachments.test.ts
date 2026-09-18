import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  attachmentFileExtension,
  CherryAttachmentStore,
  parseImageAttachmentRef,
  sniffImageContainer
} from '../attachments'

/** 主测试 setup mock 掉 node:os（无 tmpdir），临时目录挂进程工作目录下统一清扫。 */
const TEMP_BASE = join(process.cwd(), '.tmp-kernel-attachments-tests')

/** 构造最小 PNG 头（签名 + IHDR 前 8 字节），IHDR 尺寸可指定。 */
function pngBytes(width: number, height: number, pad = 0): Uint8Array {
  const data = new Uint8Array(24 + pad)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  data.set([0, 0, 0, 13], 8)
  data.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  data[16] = (width >>> 24) & 0xff
  data[17] = (width >>> 16) & 0xff
  data[18] = (width >>> 8) & 0xff
  data[19] = width & 0xff
  data[20] = (height >>> 24) & 0xff
  data[21] = (height >>> 16) & 0xff
  data[22] = (height >>> 8) & 0xff
  data[23] = height & 0xff
  return data
}

/** 最小 JPEG：SOI + SOF0 段（precision + height + width）。 */
function jpegBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(19)
  data.set([0xff, 0xd8], 0)
  data.set([0xff, 0xc0], 2)
  data[4] = 0x00
  data[5] = 0x11 // 段长 17
  data[6] = 0x08 // precision
  data[7] = (height >>> 8) & 0xff
  data[8] = height & 0xff
  data[9] = (width >>> 8) & 0xff
  data[10] = width & 0xff
  data.set([0xff, 0xd9], 17)
  return data
}

function gifBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(14)
  data.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // 'GIF89a'
  data[6] = width & 0xff
  data[7] = (width >>> 8) & 0xff
  data[8] = height & 0xff
  data[9] = (height >>> 8) & 0xff
  return data
}

function webpLBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(30)
  data.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
  data.set([0x57, 0x45, 0x42, 0x50], 8) // 'WEBP'
  data.set([0x56, 0x50, 0x38, 0x4c], 12) // 'VP8L'
  data[20] = 0x2f // 签名
  const bits = (width - 1) | ((height - 1) << 14)
  data[21] = bits & 0xff
  data[22] = (bits >>> 8) & 0xff
  data[23] = (bits >>> 16) & 0xff
  data[24] = (bits >>> 24) & 0xff
  return data
}

function webpXBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(30)
  data.set([0x52, 0x49, 0x46, 0x46], 0)
  data.set([0x57, 0x45, 0x42, 0x50], 8)
  data.set([0x56, 0x50, 0x38, 0x58], 12) // 'VP8X'
  data[24] = (width - 1) & 0xff
  data[25] = ((width - 1) >>> 8) & 0xff
  data[26] = ((width - 1) >>> 16) & 0xff
  data[27] = (height - 1) & 0xff
  data[28] = ((height - 1) >>> 8) & 0xff
  data[29] = ((height - 1) >>> 16) & 0xff
  return data
}

function webpLossyBytes(width: number, height: number): Uint8Array {
  const data = new Uint8Array(30)
  data.set([0x52, 0x49, 0x46, 0x46], 0)
  data.set([0x57, 0x45, 0x42, 0x50], 8)
  data.set([0x56, 0x50, 0x38, 0x20], 12) // 'VP8 '
  data.set([0x9d, 0x01, 0x2a], 23)
  data[26] = width & 0xff
  data[27] = (width >>> 8) & 0x3f
  data[28] = height & 0xff
  data[29] = (height >>> 8) & 0x3f
  return data
}

describe('sniffImageContainer', () => {
  it('parses PNG IHDR dimensions', () => {
    expect(sniffImageContainer(pngBytes(1024, 768))).toEqual({ mediaType: 'image/png', width: 1024, height: 768 })
  })
  it('parses JPEG SOF dimensions', () => {
    expect(sniffImageContainer(jpegBytes(800, 600))).toEqual({ mediaType: 'image/jpeg', width: 800, height: 600 })
  })
  it('parses GIF logical screen dimensions', () => {
    expect(sniffImageContainer(gifBytes(320, 240))).toEqual({ mediaType: 'image/gif', width: 320, height: 240 })
  })
  it('parses WebP VP8L dimensions', () => {
    expect(sniffImageContainer(webpLBytes(640, 480))).toEqual({ mediaType: 'image/webp', width: 640, height: 480 })
  })
  it('parses WebP VP8X canvas dimensions', () => {
    expect(sniffImageContainer(webpXBytes(1000, 500))).toEqual({ mediaType: 'image/webp', width: 1000, height: 500 })
  })
  it('parses WebP lossy VP8 dimensions', () => {
    expect(sniffImageContainer(webpLossyBytes(1920, 1080))).toEqual({
      mediaType: 'image/webp',
      width: 1920,
      height: 1080
    })
  })
  it('rejects garbage and short payloads', () => {
    expect(sniffImageContainer(new Uint8Array(0))).toBeUndefined()
    expect(sniffImageContainer(new Uint8Array(8))).toBeUndefined()
    expect(sniffImageContainer(new TextEncoder().encode('not an image at all ........'))).toBeUndefined()
  })
})

describe('parseImageAttachmentRef', () => {
  const valid = {
    attachmentId: 'a'.repeat(64),
    mediaType: 'image/png',
    bytes: 10,
    width: 4,
    height: 4
  }
  it('accepts a well-formed sha256 ref', () => {
    expect(parseImageAttachmentRef(valid).attachmentId).toBe(valid.attachmentId)
  })
  it('rejects malformed ids, media types and numbers', () => {
    expect(() => parseImageAttachmentRef({ ...valid, attachmentId: '../etc/passwd' })).toThrowError()
    expect(() => parseImageAttachmentRef({ ...valid, mediaType: 'image/bmp' })).toThrowError()
    expect(() => parseImageAttachmentRef({ ...valid, bytes: 0 })).toThrowError()
    expect(() => parseImageAttachmentRef({ ...valid, width: -1 })).toThrowError()
    expect(() => parseImageAttachmentRef(null)).toThrowError()
  })
})

describe('CherryAttachmentStore', () => {
  let root: string
  let store: CherryAttachmentStore

  beforeAll(async () => {
    await mkdir(TEMP_BASE, { recursive: true })
  })

  afterAll(async () => {
    await rm(TEMP_BASE, { recursive: true, force: true })
  })

  beforeEach(async () => {
    root = await mkdtemp(TEMP_BASE + '-')
    store = new CherryAttachmentStore(new Context(), { root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('declares deployment limits within the pi-ai default request budget', () => {
    expect(store.imageLimits.maxImageBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(store.imageLimits.maxImagePixels).toBeLessThanOrEqual(2048 * 2048)
    expect(store.imageLimits.mediaTypes).toHaveLength(4)
  })

  it('saveImage + readImage roundtrip preserves bytes and derives the id from the digest', async () => {
    const bytes = pngBytes(64, 48, 100)
    const ref = await store.saveImage({ data: bytes, mediaType: 'image/png' })
    expect(ref.attachmentId).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.width).toBe(64)
    expect(ref.height).toBe(48)
    expect(ref.bytes).toBe(bytes.byteLength)
    // Buffer/Uint8Array 原型不同，按内容比较
    expect(Buffer.from(await readFile(join(root, `${ref.attachmentId}.png`))).equals(Buffer.from(bytes))).toBe(true)

    const stored = await store.readImage(ref)
    expect(Buffer.from(stored.data).equals(Buffer.from(bytes))).toBe(true)
  })

  it('content-addresses identical payloads to the same id', async () => {
    const bytes = pngBytes(10, 10, 5)
    const first = await store.saveImage({ data: bytes, mediaType: 'image/png' })
    const second = await store.saveImage({ data: bytes, mediaType: 'image/png', name: 'copy.png' })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(second.name).toBe('copy.png')
  })

  it('rejects over-budget, mismatched and garbage payloads', async () => {
    // 合法 PNG 头 + 超限字节（容器校验在前，字节预算在后）
    const oversized = pngBytes(64, 48, 1024 * 1024 + 1 - 24)
    await expect(store.saveImage({ data: oversized, mediaType: 'image/png' })).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    })
    await expect(store.saveImage({ data: pngBytes(4096, 10), mediaType: 'image/png' })).rejects.toMatchObject({
      code: 'IMAGE_DIMENSION_TOO_LARGE'
    })
    await expect(store.saveImage({ data: pngBytes(10, 10), mediaType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'IMAGE_TYPE_MISMATCH'
    })
    await expect(
      store.saveImage({ data: new TextEncoder().encode('garbage!'), mediaType: 'image/png' })
    ).rejects.toMatchObject({
      code: 'INVALID_IMAGE'
    })
  })

  it('flags corrupted or missing blobs at read time', async () => {
    const bytes = pngBytes(16, 16, 20)
    const ref = await store.saveImage({ data: bytes, mediaType: 'image/png' })
    await writeFile(join(root, `${ref.attachmentId}.png`), pngBytes(16, 16, 21))
    await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await unlink(join(root, `${ref.attachmentId}.png`))
    await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })

  it('readImageRequest passes stored bytes through within the route budget and fails loudly outside it', async () => {
    const bytes = pngBytes(256, 256, 50)
    const ref = await store.saveImage({ data: bytes, mediaType: 'image/png' })

    const request = await store.readImageRequest(ref, { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 })
    expect(request.data).toEqual(bytes)
    expect(request.variantId).toContain(ref.attachmentId)
    expect(request.hasAlpha).toBe(true)

    await expect(store.readImageRequest(ref, { maxPixels: 100, maxBytes: 1024 * 1024 })).rejects.toMatchObject({
      code: 'IMAGE_TOO_MANY_PIXELS'
    })
    await expect(store.readImageRequest(ref, { maxPixels: 2048 * 2048, maxBytes: 4 })).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE'
    })
  })

  it('maps media types to file extensions', () => {
    expect(attachmentFileExtension('image/png')).toBe('.png')
    expect(attachmentFileExtension('image/jpeg')).toBe('.jpg')
  })
})
