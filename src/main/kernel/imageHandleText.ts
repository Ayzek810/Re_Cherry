/**
 * 请求侧图片句柄短锚（传输层；请求端）。
 *
 * 背景（2026-09-18 真机实录）：pi-ai 适配器在 wire 上把每个 image part 连同一条上游
 * 句柄文本（dsh-llm `requestImageHandleText`：`Image <64位hash>; request image 750x764px.`）
 * 一并发给模型。这句英文+哈希混在中文对话里，模型会当成用户话语来接（"关于你提到的
 * Image 07843a4c... 我目前没有可用的图像读取或处理工具"、把尺寸当用户给的参数复述）。
 * 句柄本意是给将来图片工具/多图引用留稳定锚——锚要保留，但不需要以全文 hash 形态入对话。
 *
 * 改写（与用户定案 A'，v0.3.1 上下文净化）：`图片N (宽x高px)`
 *   - 去 hash：模型即使复述也只是"图片1 (750x764px)"，无害；
 *   - 编号 = 进程内首见序（attachmentId 首次出现时分配；32 张滑动窗口内的同图同号，
 *     窗口外淘汰后重见的图拿新号），为将来 describe_image 类工具保留按编号寻址的锚；
 *   - 尺寸保留：模型本可感知的图片属性，多图时兼作消歧。
 *
 * 挂载方式：动作点在包内 userContent 的句柄生成处，无公开缝可投（与 thinkingReplay 同
 * 一处境），经 dsh-llm-pi-ai 补丁的第二个中性门 `globalThis.__recRequestImageHandleText
 * ?.(version) ?? requestImageHandleText(version)` 安装（门缺失 = 零行为差异）。fail-safe：
 * 门返回 undefined（形状不认识 / 内部异常）时落回上游原文本，绝不因短锚断请求。
 * 会话日志与渲染层零改动：改写只发生在"发出去的请求"这一层。
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('KernelImageHandleText')

/** 中性门（补丁侧）约定的全局键。 */
export const GATE_KEY = '__recRequestImageHandleText' as const

/** pi-ai 请求图片版本的最小形状（只读用途，不镜像完整类型）。 */
interface RequestImageVersion {
  attachment: { attachmentId: string }
  width: number
  height: number
}

/** 编号窗口上限（防长寿命进程图片 id 无界累积；同窗口内同图同号）。 */
const ANCHOR_INDEX_CAP = 32

const anchorIndexById = new Map<string, number>()
let anchorCounter = 0

/** 形状守卫：不认识的版本对象一律交回上游（fail-safe）。 */
function isRequestImageVersion(value: unknown): value is RequestImageVersion {
  const candidate = value as Partial<RequestImageVersion> | null | undefined
  if (candidate === null || typeof candidate !== 'object') return false
  const id = candidate.attachment?.attachmentId
  const { width, height } = candidate
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    typeof width === 'number' &&
    Number.isFinite(width) &&
    typeof height === 'number' &&
    Number.isFinite(height)
  )
}

/** attachmentId → 进程内首见序号（滑动窗口内稳定）。 */
function anchorIndexFor(attachmentId: string): number {
  const existing = anchorIndexById.get(attachmentId)
  if (existing !== undefined) return existing
  if (anchorIndexById.size >= ANCHOR_INDEX_CAP) {
    // Map 迭代序 = 插入序：淘汰最早插入者（= 最早分配号的活图）。
    const oldest = anchorIndexById.keys().next().value
    if (oldest !== undefined) anchorIndexById.delete(oldest)
  }
  anchorCounter += 1
  anchorIndexById.set(attachmentId, anchorCounter)
  return anchorCounter
}

/** 中性门实现：任何内部异常都按 fail-safe 落回上游文本（undefined = 门放弃接管）。 */
function gate(version: unknown): string | undefined {
  try {
    if (!isRequestImageVersion(version)) return undefined
    const typed = version
    return `图片${anchorIndexFor(typed.attachment.attachmentId)} (${typed.width}x${typed.height}px)`
  } catch (error) {
    logger.error(`kernel: image handle gate failed, falling back to upstream text — ${String(error)}`)
    return undefined
  }
}

/** 装载中性门（boot 一次）。返回真值便于测试断言。 */
export function installRequestImageHandleAnchor(): boolean {
  const holder = globalThis as Record<string, unknown>
  if (typeof holder[GATE_KEY] === 'function') return false
  holder[GATE_KEY] = gate
  logger.info('kernel: request image handle short anchor installed (图片N (WxHpx), hash-free)')
  return true
}

/** 卸载并清空编号窗口（测试用）。 */
export function uninstallRequestImageHandleAnchor(): void {
  delete (globalThis as Record<string, unknown>)[GATE_KEY]
  anchorIndexById.clear()
  anchorCounter = 0
}
