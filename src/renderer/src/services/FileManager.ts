import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { getFileDirectory, getFileExtension } from '@renderer/utils'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import dayjs from 'dayjs'

const logger = loggerService.withContext('FileManager')

/** 后缀 → 分类（与主进程 `getFileType` 同源：同一批 `@shared/config/constant` 名单）。 */
const EXT_TYPE_MAP = new Map<string, FileMetadata['type']>([
  ...imageExts.map((ext) => [ext, FILE_TYPE.IMAGE] as const),
  ...documentExts.map((ext) => [ext, FILE_TYPE.DOCUMENT] as const),
  ...textExts.map((ext) => [ext, FILE_TYPE.TEXT] as const)
])

/** 下载落盘后缀被叠加的历史痕迹（见 `repairLegacyDownloadedFile`）。 */
const LEGACY_DOWNLOAD_SUFFIX = /\.bin$/i

/**
 * 修复"下载落盘后缀被 Content-Type 叠加"造成的历史行（v0.3.3-2）。
 *
 * 现场：`xxx_00001_.png` + `application/octet-stream`（→ `.bin`）曾落成 `xxx_00001_.png.bin`、
 * `ext = '.bin'`、`type = other` ⇒ 文件页「图片」分类里看不到这张 **AI 生成的图**（真机取证）。
 * 字节没坏：盘上文件名就是 `<id>.bin`，`FileManager.getFilePath` 按 `id + ext` 找文件，故 `ext`
 * **必须保留 `.bin`**，这里只修**分类**（按 origin_name 去掉那个多余后缀后的真实后缀重算 `type`）
 * 与**显示名**（`formatFileName` 读 `origin_name`）。
 *
 * @returns 需要写回的新行；无需修改返回 `null`。
 */
export function repairLegacyDownloadedFile(file: FileMetadata): FileMetadata | null {
  if (!file || typeof file.ext !== 'string' || typeof file.origin_name !== 'string') return null
  if (file.ext.toLowerCase() !== '.bin') return null
  if (!LEGACY_DOWNLOAD_SUFFIX.test(file.origin_name)) return null

  const cleanedName = file.origin_name.replace(LEGACY_DOWNLOAD_SUFFIX, '')
  const realType = EXT_TYPE_MAP.get(getFileExtension(cleanedName))
  if (realType === undefined) return null

  return { ...file, origin_name: cleanedName, type: realType }
}

class FileManager {
  static async selectFiles(options?: Electron.OpenDialogOptions): Promise<FileMetadata[] | null> {
    return await window.api.file.select(options)
  }

  static async addFile(file: FileMetadata): Promise<FileMetadata> {
    const fileRecord = await db.files.get(file.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(file)

    return file
  }

  static async addFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.addFile(file)))
  }

  static async readBinaryImage(file: FileMetadata): Promise<Buffer> {
    const fileData = await window.api.file.binaryImage(file.id + file.ext)
    return fileData.data
  }

  static async readBase64File(file: FileMetadata): Promise<string> {
    const fileData = await window.api.file.base64File(file.id + file.ext)
    return fileData.data
  }

  static async addBase64File(file: FileMetadata): Promise<FileMetadata> {
    logger.info(`Adding base64 file: ${JSON.stringify(file)}`)

    const base64File = await window.api.file.base64File(file.id + file.ext)
    const fileRecord = await db.files.get(base64File.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(base64File)

    return base64File
  }

  static async uploadFile(file: FileMetadata): Promise<FileMetadata> {
    logger.info(`Uploading file: ${JSON.stringify(file)}`)

    const uploadFile = await window.api.file.upload(file)
    logger.info('Uploaded file:', uploadFile)
    const fileRecord = await db.files.get(uploadFile.id)

    if (fileRecord) {
      await db.files.update(fileRecord.id, { ...fileRecord, count: fileRecord.count + 1 })
      return fileRecord
    }

    await db.files.add(uploadFile)

    return uploadFile
  }

  static async uploadFiles(files: FileMetadata[]): Promise<FileMetadata[]> {
    return Promise.all(files.map((file) => this.uploadFile(file)))
  }

  static async getFile(id: string): Promise<FileMetadata | undefined> {
    const file = await db.files.get(id)

    if (file) {
      const filesPath = store.getState().runtime.filesPath
      file.path = filesPath + '/' + file.id + file.ext
    }

    return file
  }

  static getFilePath(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return filesPath + '/' + file.id + file.ext
  }

  static async deleteFile(id: string, force: boolean = false): Promise<void> {
    const file = await this.getFile(id)

    logger.info('Deleting file:', file)

    if (!file) {
      return
    }

    if (!force) {
      if (file.count > 1) {
        await db.files.update(id, { ...file, count: file.count - 1 })
        return
      }
    }

    await db.files.delete(id)

    try {
      await window.api.file.delete(id + file.ext)
    } catch (error) {
      logger.error('Failed to delete file:', error as Error)
    }
  }

  static async deleteFiles(files: FileMetadata[]): Promise<void> {
    if (!files || files.length === 0) return

    const results = await Promise.allSettled(files.map((file) => this.deleteFile(file.id)))

    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      logger.warn(`File deletions completed with ${failed.length} files failed to delete:`, failed)
    }
  }

  static async allFiles(): Promise<FileMetadata[]> {
    return db.files.toArray()
  }

  /**
   * 一次性（幂等）修复 `repairLegacyDownloadedFile` 命中的历史行。启动时调一次；
   * 只改分类与显示名，不动文件名/字节；任何异常按"没答案不放权"处理——只记日志、不删不改。
   */
  static async repairLegacyDownloadedFiles(): Promise<number> {
    try {
      const candidates = await db.files.where('ext').equals('.bin').toArray()
      let repaired = 0
      for (const file of candidates) {
        const next = repairLegacyDownloadedFile(file)
        if (next === null) continue
        await db.files.put(next)
        repaired += 1
      }
      if (repaired > 0) {
        // warn 级：真机取证要看这条（renderer 的 info 不落盘，见 经验教训 §4.43）
        logger.warn(`FileManager: repaired ${repaired} legacy downloaded file row(s) misclassified as "other"`)
      }
      return repaired
    } catch (error) {
      logger.warn('FileManager: legacy downloaded file repair skipped', error as Error)
      return 0
    }
  }

  static isDangerFile(file: FileMetadata) {
    return ['.sh', '.bat', '.cmd', '.ps1', '.vbs', 'reg'].includes(file.ext)
  }

  static getSafePath(file: FileMetadata) {
    // use the path from the file metadata instead
    // this function is used to get path for files which are not in the filestorage
    return this.isDangerFile(file) ? getFileDirectory(file.path) : file.path
  }

  static getFileUrl(file: FileMetadata) {
    const filesPath = store.getState().runtime.filesPath
    return 'file://' + filesPath + '/' + file.name
  }

  static async updateFile(file: FileMetadata) {
    if (!file.origin_name.includes(file.ext)) {
      file.origin_name = file.origin_name + file.ext
    }

    await db.files.update(file.id, file)
  }

  static formatFileName(file: FileMetadata) {
    if (!file || !file.origin_name) {
      return ''
    }

    const date = dayjs(file.created_at).format('YYYY-MM-DD')

    if (file.origin_name.includes('pasted_text')) {
      return date + ' ' + i18n.t('message.attachments.pasted_text') + file.ext
    }

    if (file.origin_name.startsWith('temp_file') && file.origin_name.includes('image')) {
      return date + ' ' + i18n.t('message.attachments.pasted_image') + file.ext
    }

    return file.origin_name
  }
}

export default FileManager
