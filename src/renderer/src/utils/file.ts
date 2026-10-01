import { loggerService } from '@logger'
import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { audioExts, documentExts, GB, imageExts, KB, MB, textExts, videoExts } from '@shared/config/constant'
import mime from 'mime-types'

const logger = loggerService.withContext('Utils:File')

/**
 * 从文件路径中提取目录路径。
 * @param {string} filePath 文件路径
 * @returns {string} 目录路径
 */
export function getFileDirectory(filePath: string): string {
  const parts = filePath.split('/')
  return parts.slice(0, -1).join('/')
}

/**
 * 从文件路径中提取文件扩展名。
 * @param {string} filePath 文件路径
 * @returns {string} 文件扩展名（含前导点、小写）；没有扩展名时返回空串。
 *
 * 空串是唯一可区分的「没有扩展名」表示：原先返回 `'.'`，
 * 与「扩展名恰好是一个点」（`C:\a\b.`）不可区分，还会传进
 * `supportExts.has(...)` 与 `mime2type` 被当成真扩展名。
 * `C:\a\b`、`C:\a\b.`、`.hidden`（无基名）一律返回 `''`；调用方用 `if (!ext)` 判断。
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.')
  if (parts.length > 1) {
    const extension = parts.slice(-1)[0].toLowerCase()
    const baseName = parts.slice(0, -1).join('.')
    // `.hidden` 这类无基名的路径不算扩展名；`name.` 的扩展名是空、不是点。
    if (baseName && extension) {
      return '.' + extension
    }
  }
  return ''
}

/**
 * 格式化文件大小，根据大小返回以 MB 或 KB 为单位的字符串。
 * @param {number} size 文件大小（字节）
 * @returns {string} 格式化后的文件大小字符串
 */
export function formatFileSize(size: number): string {
  if (size >= GB) {
    return (size / GB).toFixed(1) + ' GB'
  }

  if (size >= MB) {
    return (size / MB).toFixed(1) + ' MB'
  }

  if (size >= KB) {
    return (size / KB).toFixed(0) + ' KB'
  }

  return (size / KB).toFixed(2) + ' KB'
}

/**
 * 从文件名中移除特殊字符：
 * - 替换非法字符为下划线
 * - 替换换行符为空格。
 * @param {string} str 输入字符串
 * @returns {string} 处理后的文件名字符串
 */
export function removeSpecialCharactersForFileName(str: string): string {
  return str
    .replace(/[<>:"/\\|?*.]/g, '_')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/**
 * 检查文件是否为支持的类型。
 * 支持的文件类型包括:
 * 1. 文件扩展名在supportExts集合中的文件
 * 2. 文本文件
 *
 * 失败语义：`window.api.file.isTextFile` 是 IPC 读盘探测，
 * 抛错表示「问不到答案」（文件被占用/权限/handler 未就绪），与「确实不是文本
 * 文件」同形。这里不得静默吞掉：catch 里记 `warn` 供取证，返回 false 保持
 * 现有签名（`filterSupportedFiles` 的调用方在本工作区之外，三值化改动见报告
 * 「」）。
 *
 * @param {string} filePath 文件路径
 * @param {Set<string>} supportExts 支持的文件扩展名集合
 * @returns {Promise<boolean>} 如果文件类型受支持返回true，否则返回false
 */
export async function isSupportedFile(filePath: string, supportExts: Set<string>): Promise<boolean> {
  try {
    if (supportExts.has(getFileExtension(filePath))) {
      return true
    }

    if (await window.api.file.isTextFile(filePath)) {
      return true
    }

    return false
  } catch (error) {
    logger.warn(`isSupportedFile: text-file probe failed for "${filePath}" — treating as unsupported`, error as Error)
    return false
  }
}

export async function isTextFile(filePath: string): Promise<boolean> {
  const set = new Set(textExts)
  return isSupportedFile(filePath, set)
}

export async function filterSupportedFiles(files: FileMetadata[], supportExts: string[]): Promise<FileMetadata[]> {
  const extensionSet = new Set(supportExts)
  const validationResults = await Promise.all(
    files.map(async (file) => ({
      file,
      isValid: await isSupportedFile(file.path, extensionSet)
    }))
  )
  return validationResults.filter((result) => result.isValid).map((result) => result.file)
}

export function parseFileTypes(str: string): FileType | null {
  if (Object.values(FILE_TYPE).some((type) => type === str)) {
    return str as FileType
  }
  return null
}

export const mime2type = (mimeStr: string): FileType => {
  const mimeType = mimeStr.toLowerCase()
  const ext = mime.extension(mimeType)
  if (ext) {
    if (textExts.includes(ext)) {
      return FILE_TYPE.TEXT
    } else if (imageExts.includes(ext)) {
      return FILE_TYPE.IMAGE
    } else if (documentExts.includes(ext)) {
      return FILE_TYPE.DOCUMENT
    } else if (audioExts.includes(ext)) {
      return FILE_TYPE.AUDIO
    } else if (videoExts.includes(ext)) {
      return FILE_TYPE.VIDEO
    }
  }
  return FILE_TYPE.OTHER
}
