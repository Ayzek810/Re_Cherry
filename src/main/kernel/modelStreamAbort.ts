/**
 * 在途模型流的切断（v1：暂停必须一律能打断）—— `llm/stream` waterfall 中间件。
 *
 * 要解决的问题（2026-10-01 真机取证）：用户按暂停后，**正在生成的回答会继续产出**。
 * 原因有两层：
 * 1. 内核的 `topicTree.stop(id)`（= `agent.cancel({kind:'user'})`）只在**边界**生效——
 *    实测连按 5 次暂停，`dshTopicStop` 每次都被送达，内核 `isRunning` 在 `stop()` 返回后
 *    仍为 true，随后的长活照常跑完；
 * 2. 模型请求本身没有任何"我方"的中止信号——请求是内核发的，我们只是旁观者。
 *
 * 本中间件把这两层都补上：`llm/stream` 是 dsh 文档化的 waterfall，**允许改参数**，而
 * `GenerateOptions` 同时带 `signal`（调用方中止信号）与 `sessionId`（循环打上的会话身份，
 * 在本仓 = 话题 id）。于是：
 * - 每次流式调用开始时，按 `sessionId` 把 **我们自己** 的中断控制器登记进话题工作表
 *   （`topicWorkAbort`，与文档处理通道那份长活共用同一张表、同一个中止源）；
 * - 把该控制器的信号与调用方信号**合成**后交给 `next()`——这才是"真切断"：暂停到达时
 *   `Dsh_TopicStop` 调 `abortTopicWork(topicId)`，在途 HTTP 请求当场被 abort，
 *   `LlmRuntime` 把它规范成流协议唯一的终止形式 `finish { kind: 'aborted' }`。
 * - 流结束（正常结束、异常、被中止、消费方提前 return）一律在 `finally` 里注销。
 *
 * 零行为差异保证：没有人按暂停时，本中间件只是多合成一个永不触发的信号 + 一次登记/注销；
 * 无 `sessionId` 的调用（如会话标题、压缩这类辅助请求）**原样委托**，连登记都不做。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { loggerService } from '@logger'

import { registerTopicWork } from '../services/topicWorkAbort'

const logger = loggerService.withContext('KernelModelStreamAbort')

/** waterfall 的 `next`：接受（可改写的）调用参数，返回分片流。 */
export type ModelStreamNext = (options?: GenerateOptions) => AsyncIterable<StreamChunk>

/**
 * 包一层流：把"注销登记"绑到流的终态上。消费方提前 `return()`、抛错、正常耗尽都覆盖。
 * 只有**真的被切断**（我方控制器已中止）才落一行 info——这是"暂停确实掐断了模型流"的
 * 取证锚点，平时不产生日志噪音。
 * @param source - 下游（真正发请求）的分片流。
 * @param unregister - 话题工作登记表的注销函数。
 * @param controller - 本次流登记的中断控制器。
 * @param topicId - 话题 id（日志用）。
 */
async function* withTopicWorkRegistration(
  source: AsyncIterable<StreamChunk>,
  unregister: () => void,
  controller: AbortController,
  topicId: string
): AsyncIterable<StreamChunk> {
  try {
    for await (const chunk of source) yield chunk
  } finally {
    if (controller.signal.aborted) {
      logger.info(`kernel: model stream cut by topic stop for "${topicId}"`)
    }
    unregister()
  }
}

/**
 * 一次流式调用的包装：登记我方中断信号 → 合成进 `options.signal` → 委托下游。
 *
 * 导出供单测直接驱动（不依赖 cordis 装配）。
 */
export function wrapModelStream(options: GenerateOptions, next: ModelStreamNext): AsyncIterable<StreamChunk> {
  const topicId = options.sessionId
  if (topicId === undefined) {
    // 辅助调用（会话标题/压缩）没有会话身份 → 不登记、不改参数，原样透传。
    return next()
  }
  const controller = new AbortController()
  const unregister = registerTopicWork(topicId, controller)
  const callerSignal = options.signal
  const combined = callerSignal === undefined ? controller.signal : AbortSignal.any([callerSignal, controller.signal])
  let source: AsyncIterable<StreamChunk>
  try {
    source = next({ ...options, signal: combined })
  } catch (error) {
    // 下游同步抛错（未构造出流）：登记必须立刻撤，不能留悬空控制器。
    unregister()
    throw error
  }
  return withTopicWorkRegistration(source, unregister, controller, topicId)
}

/**
 * 在 root 装配"暂停可切断模型流"中间件（与 `registerDsmlRepair` 同一 waterfall，全局注册）。
 * @param ctx - 内核 root 上下文。
 */
export function registerModelStreamAbort(ctx: Context): void {
  // 每次调用不打日志（一轮里每个 step 都会过这里，会变噪音）；"真被切断"的取证在
  // withTopicWorkRegistration 的终态里，只在暂停生效时落一行。
  ctx.on('llm/stream', (options: GenerateOptions, next: ModelStreamNext) => wrapModelStream(options, next), {
    global: true
  })
  logger.info('kernel: model stream abort registered on llm/stream')
}
