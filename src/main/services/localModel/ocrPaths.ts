/**
 * 本地 PaddleOCR 模型的盘上路径与就绪探测（v0.3.2 自 CS_V2 移植）。
 * 存储在 {userData}/Runtime/models/pp-ocrv6——故意放 Data/ 之外（BackupManager
 * 全量备份 Data，140MB 权重不该进备份包）。模型身份（仓库/文件名）在
 * localModelCatalog；就绪 = 三文件齐（盘 = 真相源，重启无状态）。
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { LOCAL_MODELS } from './localModelCatalog'

const { weights, dictionary } = LOCAL_MODELS.ocr

export function ocrModelDir(): string {
  return path.join(app.getPath('userData'), 'Runtime', 'models', 'pp-ocrv6')
}

export async function ensureOcrModelDir(): Promise<string> {
  const dir = ocrModelDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export function ocrModelPaths(): { detection: string; recognition: string; charactersDictionary: string } {
  const dir = ocrModelDir()
  return {
    detection: path.join(dir, weights.detection.fileName),
    recognition: path.join(dir, weights.recognition.fileName),
    charactersDictionary: path.join(dir, dictionary.fileName)
  }
}

/** 检测/识别权重 + 字典三文件齐 = 就绪。 */
export function isLocalOcrModelDownloaded(): boolean {
  const paths = ocrModelPaths()
  return existsSync(paths.detection) && existsSync(paths.recognition) && existsSync(paths.charactersDictionary)
}
