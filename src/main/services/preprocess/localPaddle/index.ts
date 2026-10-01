/**
 * LocalPaddle 门面（收编落点）：文档处理通道的本地服务商实现。
 *
 * 架构裁决（2026-09-27 用户定调）：LocalPaddle 本质上是文档处理的子系统，
 * 不是独立系统——「本地模型系统」（generic catalog/状态机/镜像表/独立 IPC 命名
 * 空间）的壳整体拆除，模型仓（modelStore）、推理编排（localOcr）、utility 入口
 * （localOcrWorker）、资产表（modelAssets）全部归位本目录，对外只留这一个门面：
 * 通道执行缝走 parsePdf（preprocessChannel 路由），下载生命周期走 getStatus/
 * download/cancel/remove（IPC 薄转发 + 渲染层 useLocalPaddle）。
 */
import type { LocalOcrOptions } from './localOcr'
import { runLocalOcr } from './localOcr'
import type { LocalPaddleStatus } from './modelStore'
import { localPaddleModelStore } from './modelStore'

export type { LocalOcrOptions } from './localOcr'
export type { LocalPaddleStatus } from './modelStore'

/** 文档处理通道执行缝：整本 PDF 本机 OCR（模型未下载在入口如实报可行动错误）。 */
export function parsePdf(filePath: string, options: LocalOcrOptions = {}, signal?: AbortSignal): Promise<string> {
  return runLocalOcr(filePath, options, signal)
}

/** 渲染层模型下载卡片的状态（进度由渲染层轮询 getStatus）。 */
export function getStatus(): LocalPaddleStatus {
  return localPaddleModelStore.getStatus()
}

export function download(): Promise<void> {
  return localPaddleModelStore.download()
}

export function cancel(): void {
  localPaddleModelStore.cancel()
}

export function remove(): Promise<void> {
  return localPaddleModelStore.remove()
}
