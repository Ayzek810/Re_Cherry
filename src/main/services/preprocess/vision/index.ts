/**
 * 视觉模型文档处理门面（v0.4.4）：文档处理通道 vision-model 条目的服务商实现。
 *
 * 架构定位（2026-09-28 用户裁决）：**视觉模型本质上是文档处理的子系统，不是一个
 * 单独的系统**——通道里多一个服务商条目（与云端五家、LocalPaddle 并列），执行缝
 * 是本目录（编排 + 光栅化 worker），配置面是 preprocess 切片里该条目的视觉模型
 * 引用（provider + model），对外只留这一个门面：通道执行缝走 parsePdf。
 */
import type { VisionDocumentConfig } from './visionParse'
import { runVisionDocumentParse } from './visionParse'

export type { VisionDocumentConfig } from './visionParse'
export { VISION_DOCUMENT_PROMPT, visionWorkerPath } from './visionParse'

/** 文档处理通道执行缝：整本 PDF 走视觉模型逐页转写。 */
export function parsePdf(filePath: string, config: VisionDocumentConfig, signal?: AbortSignal): Promise<string> {
  return runVisionDocumentParse(filePath, config, signal)
}
