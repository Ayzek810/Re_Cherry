/**
 * read_document 每轮登记缝（ctx.documents，批次6 文档阅读接线；webSearch/knowledge/
 * skills 同先例）。v0.3.2 验收轮重构：状态本体在主进程 knowledgeService（文档处理
 * 系统，工具执行直读单例；原 DocumentService 已删除），本缝只承担 cordis 声明制
 * 落位与转发。
 */
import { type Context, Service } from '@deepseek-ai/cordis'

import type { TurnDocument } from '../services/knowledge/KnowledgeService'
import { knowledgeService } from '../services/knowledge/KnowledgeService'

export type { TurnDocument }

export class DocumentKernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'documents')
  }

  /** 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮无文档附件）。 */
  setTurnDocuments(topicId: string, documents: TurnDocument[] | undefined): void {
    knowledgeService.setTurnDocuments(topicId, documents)
  }
}
