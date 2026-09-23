import { loggerService } from '@logger'
import { getImageBlobFromSource } from '@renderer/utils/image'

const logger = loggerService.withContext('paintings/computeImageNaturalSize')

export interface ImageNaturalSize {
  naturalWidth: number
  naturalHeight: number
}

/**
 * Decode the generated image's intrinsic pixel size via `createImageBitmap`, so the
 * reveal skeleton can relock its box to the exact size the real `<img>` will render
 * at instead of the declared-ratio estimate (avoiding a size jump on reveal). Returns
 * null (logged) when the source can't be decoded — the artboard then skips the animated
 * reveal and shows the finished image directly.
 *
 * 真因记录（v0.3.3-10）：实机报 `Not an image blob: application/octet-stream` —— 绘画文件是
 * `file://` + 无扩展名的存储名，`mime.getType` 给不出类型，而 `assertImageBlob` 当时把
 * octet-stream 当硬错误（V2 明确容忍它，见 `utils/image.ts`）。修在源头的 `assertImageBlob`
 * 之后本函数无需绕道：`createImageBitmap` 本来就按字节嗅探，不依赖 Blob 的 MIME。
 */
export async function computeImageNaturalSize(src: string): Promise<ImageNaturalSize | null> {
  let bitmap: ImageBitmap | null = null

  try {
    const blob = await getImageBlobFromSource(src)
    bitmap = await createImageBitmap(blob)
    return { naturalWidth: bitmap.width, naturalHeight: bitmap.height }
  } catch (error) {
    logger.warn('Failed to compute natural size for painting image', { error })
    return null
  } finally {
    bitmap?.close()
  }
}
