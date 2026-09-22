/**
 * knowledge_search 每轮登记缝（ctx.knowledge，批次4 知识库接线；webSearch 同先例）。
 *
 * 渲染层 messageThunk 在助手挂知识库（assistant.knowledge_bases 非空）的轮把
 * 'knowledge_search' 并入 builtinTools，随发送参数 options.knowledgeBases 上行
 * 本轮可检索的库清单（id/分块参数/嵌入模型引用）；工具执行时按 topicId 反查。
 * 即设即覆盖：每轮发送重写或置空，工具只在挂载轮可调。
 *
 * 落缝方式：cordis `Service` 子类（`super(ctx, 'knowledge')`）——直接给 ctx 赋属性
 * 会被 cordis 4 的声明制拒绝。库配置本体（知识库/条目列表）真相源在渲染层 redux
 * 切片；这里只持"本轮可检索"的登记，不是第二真相源。
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'

import type { KnowledgeTurnBase } from '../services/knowledge/KnowledgeService'
import { knowledgeService } from '../services/knowledge/KnowledgeService'

const logger = loggerService.withContext('KnowledgeKernel')

export type { KnowledgeTurnBase }

export class KnowledgeKernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  /**
   * 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用知识检索）。
   * 状态本体在主进程 KnowledgeService（工具执行直读单例），本缝只承担 cordis
   * 声明制落位与转发——与 webSearch 缝同分工。
   */
  setTurnBases(topicId: string, bases: KnowledgeTurnBase[] | undefined): void {
    knowledgeService.setTurnBases(topicId, bases)
  }
}

logger.debug('knowledge kernel service module loaded')
