/**
 * 生成图下载落盘（v0.3.3 批次4，② 薄适配）：createInternalEntry →
 * saveBase64Image / window.api.file.download + FileManager.addFile；toast 文案键保留。
 */
import { loggerService } from '@logger'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import i18next from 'i18next'

const logger = loggerService.withContext('paintings/downloadImages')

export interface DownloadImagesOptions {
  allowBase64DataUrls?: boolean
  showProxyWarning?: boolean
}

export async function downloadImages(urls: string[], options?: DownloadImagesOptions): Promise<FileMetadata[]> {
  const { allowBase64DataUrls = false, showProxyWarning = false } = options ?? {}

  const downloadedFiles = await Promise.all(
    urls.map(async (url): Promise<FileMetadata | null> => {
      try {
        if (!url?.trim()) {
          logger.error('Image URL is empty, possibly due to prohibited prompt')
          window.toast.warning(i18next.t('message.empty_url'))
          return null
        }
        const meta =
          allowBase64DataUrls && url.startsWith('data:image')
            ? await window.api.file.saveBase64Image(url)
            : await window.api.file.download(url, true)
        return await FileManager.addFile(meta)
      } catch (error) {
        logger.error(`Failed to download image: ${error}`)
        if (
          error instanceof Error &&
          (error.message.includes('Failed to parse URL') || error.message.includes('Invalid URL'))
        ) {
          window.toast.warning(i18next.t('message.empty_url'))
        } else if (showProxyWarning) {
          window.toast.warning(i18next.t('paintings.proxy_required'))
        }
        return null
      }
    })
  )

  return downloadedFiles.filter((file): file is FileMetadata => file !== null)
}
