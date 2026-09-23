/**
 * 绘画生成执行与落盘（v0.3.3 批次4，② 薄适配）：GenerationResult 联合 +
 * aiErrorDetail→错误码映射保留；resolvePaintingFiles 改为 fork 缝——base64 结果
 * 调 window.api.file.saveBase64Image 得 FileMetadata[]，url 结果调
 * window.api.file.download 后 FileManager.addFile 入库，返回 FileMetadata[]。
 */
import { loggerService } from '@logger'
import { createPaintingGenerateError, normalizePaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import type { LightImageResult } from '@shared/lightLlm/types'

const logger = loggerService.withContext('paintings/runPainting')

export type GenerationResult = LightImageResult

/** Map a lightLlm image failure to a painting error code (fork 缝：无 aiErrorDetail 序列化面，按 message 归类). */
function classifyError(error: unknown): Error {
  if (error instanceof Error) {
    const message = error.message ?? ''
    if (message.includes('401') || message.toLowerCase().includes('unauthorized') || message.includes('api key')) {
      return createPaintingGenerateError('REQ_ERROR_TOKEN')
    }
    if (message.includes('402') || message.toLowerCase().includes('balance') || message.toLowerCase().includes('quota')) {
      return createPaintingGenerateError('REQ_ERROR_NO_BALANCE')
    }
    if (message.includes('404') || message.toLowerCase().includes('model')) {
      return createPaintingGenerateError('MISSING_REQUIRED_FIELDS')
    }
  }
  return normalizePaintingGenerateError(error)
}

export async function resolvePaintingFiles(result: GenerationResult): Promise<FileMetadata[]> {
  let files: FileMetadata[] = []

  if (result.type === 'base64') {
    files = await Promise.all(result.images.map((b64) => window.api.file.saveBase64Image(b64)))
  } else if (result.type === 'url' && result.images.length > 0) {
    const downloaded = await Promise.all(
      result.images.map(async (url) => {
        try {
          const meta = await window.api.file.download(url, true)
          return await FileManager.addFile(meta)
        } catch (error) {
          logger.error('Failed to download painting image', { url, error })
          return null
        }
      })
    )
    files = downloaded.filter((file): file is FileMetadata => file !== null)
  }

  if (files.length === 0) {
    throw createPaintingGenerateError('GENERATE_FAILED')
  }

  return files
}

export async function runPainting(
  generate: () => Promise<GenerationResult | FileMetadata[] | void>
): Promise<FileMetadata[]> {
  try {
    const result = await generate()
    if (!result) {
      throw createPaintingGenerateError('GENERATE_FAILED')
    }
    if (Array.isArray(result)) {
      if (result.length === 0) {
        throw createPaintingGenerateError('GENERATE_FAILED')
      }
      return result
    }
    return resolvePaintingFiles(result)
  } catch (error: unknown) {
    if (error instanceof Error && error.name !== 'AbortError') {
      logger.error('Image generation failed:', error)
      throw classifyError(error)
    }
    throw error
  }
}
