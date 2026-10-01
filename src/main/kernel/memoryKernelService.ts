/**
 * memory 工具每轮登记缝（ctx.memory，v0.4.6；webSearch/knowledge/skills/documents 同先例）。
 *
 * 状态本体在主进程模块单例（skillService 同先例），本缝只承担 cordis 声明制落位与转发。
 * 每轮登记持有的是**主进程派生**的受控目录（{userData}/Data/assistant-memory/<sanitize(id)>/memory，
 * topics.sendMessage 按 assistantId 派生并确保存在——路径权威在主进程，渲染层只上行助手 id）。
 * 工具执行按 topicId 反查；FACT.md 内容注入快照节由 topics.ensureAgent 读盘组装。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { type Context, Service } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'
import { getDataPath } from '@main/utils'

const logger = loggerService.withContext('MemoryKernel')

/** 与知识库 sanitizeBaseId 同语义：防路径穿越（残留 [a-zA-Z0-9_-]）。 */
function sanitizeMemoryScope(assistantId: string): string {
  return assistantId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 主进程权威派生：助手级 memory 根目录（受控，确保存在）。 */
export function deriveMemoryRoot(assistantId: string): string {
  return join(getDataPath('assistant-memory'), sanitizeMemoryScope(assistantId), 'memory')
}

/** 每轮登记表（topicId → 受控根目录；即设即覆盖，无清理需求——turnBases 同形态）。 */
const turnRoots = new Map<string, string>()

/** 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用）。 */
export async function setTurnMemoryRoot(topicId: string, assistantId: string | undefined): Promise<void> {
  if (assistantId === undefined || assistantId.length === 0) {
    turnRoots.delete(topicId)
    return
  }
  const root = deriveMemoryRoot(assistantId)
  await mkdir(root, { recursive: true })
  turnRoots.set(topicId, root)
  logger.debug(`memory turn root registered (topic=${topicId})`)
}

/** memory 工具执行 / 漂移签名读取本轮登记的根目录；undefined = 本轮未启用。 */
export function getTurnMemoryRoot(topicId: string): string | undefined {
  return turnRoots.get(topicId)
}

export class MemoryKernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /** 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用）。 */
  setTurnRoot(topicId: string, assistantId: string | undefined): Promise<void> {
    return setTurnMemoryRoot(topicId, assistantId)
  }

  /** memory 工具执行时读取本轮登记的根目录。 */
  getTurnRoot(topicId: string): string | undefined {
    return getTurnMemoryRoot(topicId)
  }
}
