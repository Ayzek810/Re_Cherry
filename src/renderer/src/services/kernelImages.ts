import { loggerService } from '@logger'
import db from '@renderer/databases'
import type { FileMetadata } from '@types'

const logger = loggerService.withContext('KernelImages')

/**
 * 渲染侧图片通道助手（v0.3.1 识图通道）。
 *
 * 职责一（发送向）：把 Cherry 文件仓里的图片规范化成内核附件准入预算内的 base64 载荷。
 *   规范化在渲染进程做——这里有 canvas（EXIF 摆正 + 解码证明 + 重编码），主进程附件仓库
 *   只做容器校验（见 src/main/kernel/attachments.ts），零图像编解码依赖。
 * 职责二（回放向）：把内核图片附件按 ref 同步回本地文件仓（确定性 id，幂等），
 *   供 IMAGE 块按普通文件渲染；内核附件仓仍是唯一真相源。
 */

/** 目标编码字节上限：留 6% 余量低于内核准入的 1MB 与 pi-ai 默认单图请求预算。 */
const MAX_ENCODED_BYTES = 950 * 1024
/** 规范化最长边：对齐 pi-ai 默认请求像素预算（2048²）与内核准入的单边限制。 */
const MAX_LONG_EDGE = 2048

/** 扩展名 → wire 媒体类型（仅 v1 附件路径接受的四种；bmp 等由 canvas 转码成 png）。 */
const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** 随消息发往内核的图片 wire 载荷（EncodedImageAttachment 的 IPC 形态）。 */
export interface KernelImageInput {
  mediaType: string
  data: string
  name?: string
}

/** 内核图片附件引用的渲染侧形态（ImageAttachmentRef 的子集，回放同步用）。 */
export interface KernelImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read encoded image blob'))
    reader.readAsDataURL(blob)
  })
}

interface EncodedCanvas {
  mediaType: string
  data: string
  width: number
  height: number
}

/** 画布编码：按策略表逐级压质/缩边，直到落进字节预算（或返回最后一次结果交内核拒绝）。 */
async function encodeCanvas(canvas: OffscreenCanvas): Promise<EncodedCanvas> {
  const strategies: Array<{ type: string; quality?: number }> = [
    { type: 'image/png' },
    { type: 'image/jpeg', quality: 0.85 },
    { type: 'image/jpeg', quality: 0.7 }
  ]
  for (const strategy of strategies) {
    const blob = await canvas.convertToBlob({ type: strategy.type, quality: strategy.quality })
    if (blob.size <= MAX_ENCODED_BYTES) {
      return {
        mediaType: strategy.type,
        data: await blobToBase64(blob),
        width: canvas.width,
        height: canvas.height
      }
    }
  }
  // 仍超预算：逐级缩边后用 jpeg 0.7 兜底（有界循环，缩到 0.3x 为止）。
  let scale = 0.7
  while (scale >= 0.3) {
    const scaled = new OffscreenCanvas(
      Math.max(1, Math.round(canvas.width * scale)),
      Math.max(1, Math.round(canvas.height * scale))
    )
    const ctx = scaled.getContext('2d')
    if (ctx === null) break
    const source = await createImageBitmap(canvas)
    ctx.drawImage(source, 0, 0, scaled.width, scaled.height)
    source.close()
    const blob = await scaled.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    if (blob.size <= MAX_ENCODED_BYTES) {
      logger.info(`kernelImages: downscaled image to ${scaled.width}x${scaled.height} to fit the request budget`)
      return {
        mediaType: 'image/jpeg',
        data: await blobToBase64(blob),
        width: scaled.width,
        height: scaled.height
      }
    }
    scale -= 0.2
  }
  logger.warn('kernelImages: image still exceeds the request budget after all encode strategies')
  return { mediaType: 'image/jpeg', data: '', width: canvas.width, height: canvas.height }
}

/**
 * 把一个 Cherry 图片文件规范化为内核附件载荷新形态。
 * 动图取首帧（视觉模型只吃静帧）；canvas 解码失败即抛错——发送链上可见失败，
 * 不做静默降级（附件仓库是准入的最后防线，容器不实会被 IMAGE_TYPE_MISMATCH 拒绝）。
 */
export async function encodeImageFileForKernel(file: FileMetadata): Promise<KernelImageInput> {
  const record = await window.api.file.base64File(file.id + file.ext)
  const bytes = base64ToBytes(record.data)
  const declaredType = MEDIA_TYPE_BY_EXT[file.ext.toLowerCase()]

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: declaredType ?? 'image/png' }))
  } catch (error) {
    throw new Error(
      `Unsupported image "${file.origin_name}": ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('OffscreenCanvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const encoded = await encodeCanvas(canvas)
    if (encoded.data.length === 0) {
      throw new Error(`Image "${file.origin_name}" could not be encoded within the request budget`)
    }
    return {
      mediaType: encoded.mediaType,
      data: encoded.data,
      ...(file.origin_name ? { name: file.origin_name } : {})
    }
  } finally {
    bitmap.close()
  }
}

/** 已同步的内核附件 ref → FileMetadata（进程内缓存：同 ref 只走一次 IPC）。 */
const syncedRefs = new Map<string, FileMetadata>()

/**
 * 回放同步：按内核附件 ref 取回字节并落入本地文件仓（确定性 id `<attachmentId>.<ext>`）。
 * @returns 可直接放进 IMAGE 块的 FileMetadata；失败返回 null（调用方投影占位文本）。
 */
export async function syncKernelImageAttachment(ref: KernelImageRef): Promise<FileMetadata | null> {
  const cached = syncedRefs.get(ref.attachmentId)
  if (cached !== undefined) return cached
  try {
    const { file } = await window.api.dshAttachmentSync(ref)
    // 确定性 id：put = 幂等 upsert（重复回放/多话题引用同一附件不会膨胀文件仓）
    await db.files.put(file)
    syncedRefs.set(ref.attachmentId, file)
    return file
  } catch (error) {
    logger.error(`kernelImages: failed to sync kernel attachment "${ref.attachmentId}"`, error as Error)
    return null
  }
}
