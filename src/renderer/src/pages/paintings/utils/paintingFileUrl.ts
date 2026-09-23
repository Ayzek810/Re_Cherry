/**
 * 绘画文件 URL 出口（v0.3.3 批次4，V2 paintingFileUrl 重写为 fork 薄封装）：
 * feature 内统一经 FileManager 取 file:// URL / 物理路径，不各自拼 filesPath。
 * V2 的 safe-file-url 校验在 fork 缝里由 FileManager.getFileUrl 的 filesPath
 * 拼接语义替代（文件字节都在 FileStorage 仓内）。
 */
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'

/** 生成图渲染 URL（file://；无 name 的记录回退物理路径）。 */
export function getPaintingFileUrl(file: FileMetadata): string {
  return FileManager.getFileUrl(file)
}

/** 生成图物理路径（另存/外部打开用）。 */
export function getPaintingFilePath(file: FileMetadata): string {
  return FileManager.getFilePath(file)
}
