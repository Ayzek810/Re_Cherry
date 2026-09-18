import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment
} from '@deepseek-ai/dsh-attachment'
import { AttachmentError, AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { loggerService } from '@logger'

const logger = loggerService.withContext('KernelAttachments')

/**
 * 内容寻址图片附件仓库：`ctx.attachments` 服务缝的宿主实现（v0.3.1 识图通道的地基）。
 *
 * 设计要点：
 * - **规范化在渲染进程完成**（canvas 解码 + EXIF 摆正 + 尺寸/体积压到默认请求预算内），
 *   这里只做容器校验（魔数 + 尺寸头解析，零图像编解码依赖）。基类契约要求 validateImage
 *   "完整解码光栅"——本部署由渲染侧 createImageBitmap 承担解码证明，主进程复核容器结构；
 *   越限图片在准入即拒（适配器同款教义：宁可拒绝，不可谎报）。
 * - **内容寻址存储**：attachmentId = sha256 十六进制，blob 落 `<kernelDir>/attachments/<id>.<ext>`。
 *   同图去重免费；会话日志只存 ref（不存字节），重启后按 ref 读回。
 * - **readImageRequest 直通策略**：渲染侧已把图压进 pi-ai 默认请求预算
 *   （单图 ≤1MB、≤2048² 像素），直通返回存储字节并生成确定性 variantId；
 *   路由策略比部署限制更严时大声失败（IMAGE_TOO_MANY_PIXELS / IMAGE_TOO_LARGE），
 *   绝不静默发送超预算字节。
 * - 孤儿 blob（消息删除后无引用的文件）留待未来保留策略清扫——基类文档明示这是合法状态。
 */

/** v1 附件路径接受的图片格式（与 dsh-attachment 的 ImageMediaType 一致）。 */
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const EXT_BY_MEDIA_TYPE: Record<ImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

/** 本部署的准入限制：与 pi-ai 默认请求预算对齐（单图 1MB / 2048² 像素），渲染侧规范化目标即此。 */
const IMAGE_ATTACHMENT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1_048_576,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 10_485_760,
  maxImagePixels: 2048 * 2048,
  maxImageDimension: 2048,
  mediaTypes: IMAGE_MEDIA_TYPES
}

/** 单图附件 id（sha256 十六进制，64 位小写）；同时是 blob 文件名主干与跨进程同步的确定性键。 */
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}$/

interface ImageDimensions {
  mediaType: ImageMediaType
  width: number
  height: number
}

function readU16BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1]
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}

function readU24LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
}

function readU32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
}

/** PNG：IHDR 是首个块，宽高在其数据区前 8 字节（大端 u32）。 */
function pngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 24) return undefined
  const width = readU32BE(data, 16)
  const height = readU32BE(data, 20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** JPEG：扫描 SOFn 段取编码尺寸（C0-CF，跳过 C4/C8/CC 与无长度段）。 */
function jpegDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined
    const marker = data[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = readU16BE(data, offset + 2)
    if (length < 2) return undefined
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > data.length) return undefined
      const height = readU16BE(data, offset + 5)
      const width = readU16BE(data, offset + 7)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    offset += 2 + length
  }
  return undefined
}

/** WebP：VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种子格式的编码尺寸。 */
function webpDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 30) return undefined
  const fourcc = String.fromCharCode(data[12], data[13], data[14], data[15])
  if (fourcc === 'VP8 ') {
    // 帧头 3 字节 + 起始码 9D 01 2A 之后是 14 位宽高（小端 u16 的低 14 位）
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return undefined
    const width = readU16LE(data, 26) & 0x3fff
    const height = readU16LE(data, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (fourcc === 'VP8L') {
    if (data[20] !== 0x2f) return undefined
    const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  if (fourcc === 'VP8X') {
    const width = readU24LE(data, 24) + 1
    const height = readU24LE(data, 27) + 1
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  return undefined
}

/** GIF：文件头后即为逻辑屏幕宽高（小端 u16）。 */
function gifDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 10) return undefined
  const width = readU16LE(data, 6)
  const height = readU16LE(data, 8)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * 容器嗅探 + 编码尺寸解析（纯函数，供单测）。
 * @returns 无法识别的容器返回 undefined（调用方给 INVALID_IMAGE）。
 */
export function sniffImageContainer(data: Uint8Array): ImageDimensions | undefined {
  if (data.length < 12) return undefined
  const isPng =
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a
  if (isPng) {
    const dims = pngDimensions(data)
    return dims === undefined ? undefined : { mediaType: 'image/png', ...dims }
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const dims = jpegDimensions(data)
    return dims === undefined ? undefined : { mediaType: 'image/jpeg', ...dims }
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    const dims = webpDimensions(data)
    return dims === undefined ? undefined : { mediaType: 'image/webp', ...dims }
  }
  const header = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5])
  if (header === 'GIF87a' || header === 'GIF89a') {
    const dims = gifDimensions(data)
    return dims === undefined ? undefined : { mediaType: 'image/gif', ...dims }
  }
  return undefined
}

function probeImage(input: SaveImageAttachment): ImageDimensions {
  if (input.data.byteLength === 0) {
    throw new AttachmentError('Image payload is empty.', 'INVALID_IMAGE')
  }
  const probed = sniffImageContainer(input.data)
  if (probed === undefined) {
    throw new AttachmentError('Image payload does not decode as a supported raster container.', 'INVALID_IMAGE')
  }
  if (probed.mediaType !== input.mediaType) {
    throw new AttachmentError(
      `Image payload is ${probed.mediaType} but was declared as ${input.mediaType}.`,
      'IMAGE_TYPE_MISMATCH'
    )
  }
  return probed
}

/** 单图全量校验：容器结构 + 声明一致性 + 字节/单边/像素预算（validateImage 与 saveImage 共用）。 */
function probeWithLimits(input: SaveImageAttachment, limits: ImageAttachmentLimits): ImageDimensions {
  const probed = probeImage(input)
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError(`Image exceeds the per-image limit of ${limits.maxImageBytes} bytes.`, 'IMAGE_TOO_LARGE')
  }
  if (probed.width > limits.maxImageDimension || probed.height > limits.maxImageDimension) {
    throw new AttachmentError(
      `Image exceeds the per-dimension limit of ${limits.maxImageDimension}px.`,
      'IMAGE_DIMENSION_TOO_LARGE'
    )
  }
  if (probed.width * probed.height > limits.maxImagePixels) {
    throw new AttachmentError(
      `Image exceeds the pixel budget of ${limits.maxImagePixels} pixels.`,
      'IMAGE_TOO_MANY_PIXELS'
    )
  }
  return probed
}

/** 校验同一份引用声明：id 形态、媒体类型、尺寸与字节量必须是正整数（IPC 入口与读回共用）。 */
export function parseImageAttachmentRef(input: unknown): ImageAttachmentRef {
  if (typeof input !== 'object' || input === null) {
    throw new AttachmentError('Attachment reference payload is missing.', 'INVALID_ATTACHMENT_REF')
  }
  const candidate = input as Record<string, unknown>
  const attachmentId = candidate.attachmentId
  if (typeof attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    throw new AttachmentError('Attachment reference carries a malformed attachment id.', 'INVALID_ATTACHMENT_REF')
  }
  const mediaType = candidate.mediaType
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
    throw new AttachmentError('Attachment reference carries an unsupported media type.', 'INVALID_ATTACHMENT_REF')
  }
  const numeric: Array<[string, number]> = [
    ['bytes', candidate.bytes as number],
    ['width', candidate.width as number],
    ['height', candidate.height as number]
  ]
  for (const [key, value] of numeric) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AttachmentError(`Attachment reference carries an invalid ${key}.`, 'INVALID_ATTACHMENT_REF')
    }
  }
  if ((candidate.bytes as number) > IMAGE_ATTACHMENT_LIMITS.maxImageBytes) {
    throw new AttachmentError('Attachment reference exceeds the per-image byte limit.', 'INVALID_ATTACHMENT_REF')
  }
  return {
    attachmentId: AttachmentId(attachmentId),
    mediaType: mediaType as ImageMediaType,
    bytes: candidate.bytes as number,
    width: candidate.width as number,
    height: candidate.height as number,
    ...(typeof candidate.name === 'string' && candidate.name.length > 0 ? { name: candidate.name } : {})
  }
}

/**
 * Cherry 附件仓库（`ctx.attachments` 宿主实现）。
 * 由 bootKernel 挂载：`ctx.plugin(CherryAttachmentStore, { root })`。
 */
export class CherryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_ATTACHMENT_LIMITS
  private readonly root: string

  constructor(ctx: Context, options: { root: string }) {
    super(ctx)
    this.root = options.root
  }

  override async validateImage(input: SaveImageAttachment): Promise<void> {
    probeWithLimits(input, this.imageLimits)
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    // saveImage 也执行完整校验（防直调绕过批量入口）；头部探测成本低，重复解析无碍。
    const probed = probeWithLimits(input, this.imageLimits)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const fileName = `${digest}${EXT_BY_MEDIA_TYPE[probed.mediaType]}`
    await mkdir(this.root, { recursive: true })
    // 内容寻址：同名即同字节；临时文件 + rename 保证半写不落终名，并发写同内容安全。
    const tempPath = join(this.root, `${digest}.${randomUUID()}.tmp`)
    const finalPath = join(this.root, fileName)
    try {
      await writeFile(tempPath, input.data)
      await rename(tempPath, finalPath)
    } catch (error) {
      throw new AttachmentError(
        `Failed to persist image attachment: ${error instanceof Error ? error.message : String(error)}`,
        'ATTACHMENT_WRITE_FAILED'
      )
    }
    return {
      attachmentId: AttachmentId(digest),
      mediaType: probed.mediaType,
      bytes: input.data.byteLength,
      width: probed.width,
      height: probed.height,
      ...(input.name === undefined ? {} : { name: input.name })
    }
  }

  override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const filePath = join(this.root, `${ref.attachmentId}${EXT_BY_MEDIA_TYPE[ref.mediaType]}`)
    let data: Uint8Array
    try {
      data = new Uint8Array(await readFile(filePath))
    } catch (error) {
      const code =
        (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_READ_FAILED'
      throw new AttachmentError(
        `Failed to read image attachment ${ref.attachmentId}: ${error instanceof Error ? error.message : String(error)}`,
        code
      )
    }
    signal?.throwIfAborted()
    // 引用核验：字节量 + 摘要必须与 ref 一致（会话日志里的 ref 是唯一真相源）。
    if (data.byteLength !== ref.bytes) {
      throw new AttachmentError(
        `Image attachment ${ref.attachmentId} is ${data.byteLength} bytes, but its reference records ${ref.bytes}.`,
        'ATTACHMENT_CORRUPT'
      )
    }
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== ref.attachmentId) {
      throw new AttachmentError(
        `Image attachment ${ref.attachmentId} failed its digest verification.`,
        'ATTACHMENT_CORRUPT'
      )
    }
    return { ref, data }
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal
  ): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal)
    // 直通策略：渲染侧规范化已对齐 pi-ai 默认预算；更严的路由预算大声失败。
    if (ref.width * ref.height > policy.maxPixels) {
      throw new AttachmentError(
        `Image ${ref.attachmentId} (${ref.width}x${ref.height}) exceeds the route pixel budget of ${policy.maxPixels} pixels.`,
        'IMAGE_TOO_MANY_PIXELS'
      )
    }
    if (stored.data.byteLength > policy.maxBytes) {
      throw new AttachmentError(
        `Image ${ref.attachmentId} (${stored.data.byteLength} bytes) exceeds the route byte budget of ${policy.maxBytes} bytes.`,
        'IMAGE_TOO_LARGE'
      )
    }
    return {
      variantId: ImageVariantId(`identity-v1:${ref.attachmentId}:${policy.maxPixels}:${policy.maxBytes}`),
      attachment: ref,
      data: stored.data,
      mediaType: ref.mediaType,
      bytes: stored.data.byteLength,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: ref.mediaType !== 'image/jpeg'
    }
  }
}

/** 供 bootKernel 与回放同步（Dsh_AttachmentSync）使用的扩展名字典。 */
export function attachmentFileExtension(mediaType: ImageMediaType): string {
  return EXT_BY_MEDIA_TYPE[mediaType]
}

logger.debug('kernel attachments module loaded')
