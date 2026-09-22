/**
 * OCR 推理宿主生命周期（main 侧）。2026-09-22 性能事故修复后，推理全部在
 * ocrWorker.js（utility 子进程）里跑（见 ocrWorker.ts / pdfOcr.ts 头注），
 * 主进程不再持有 onnx 会话——本模块只剩「模型删除前终止活子进程」的缝
 * （Windows 打开句柄会让 unlink 失败，见 localModelService 删除流）。
 */
import { loggerService } from '@logger'

import { terminateActiveOcrProcess } from './pdfOcr'

const logger = loggerService.withContext('OcrInferenceService')

/**
 * 终止活着的 OCR 子进程后执行 fn（模型删除流）。若无子进程在跑则直接执行
 * （每次调用独立派发、结束即退出，主进程无常驻会话）。
 */
export async function disposeOcrServiceThen<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await terminateActiveOcrProcess()
  } catch (error: unknown) {
    logger.warn('terminate active OCR process failed', error as Error)
  }
  return fn()
}
