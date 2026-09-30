/**
 * memory_search 内核 builtin 工具（v0.4.7 全局记忆接线，V1 MemorySearchTool 同构）。
 *
 * 与 v0.4.6 的 memory 外置工具是两套并存、互不替代：外置 memory 写助手级
 * FACT/JOURNAL 文件（工作模式作用域，见 memoryTool.ts）；本工具检索的是设置页
 * 管理的**全局记忆库**（libsql，{userData}/Data/Memory/memories.db，跨会话/跨助手
 * 共享，recall 语义）。挂载门在渲染层（messageThunk：全局记忆开关 &&
 * assistant.enableMemory，V1 searchOrchestrationPlugin 判定同构）；工具无每轮登记
 * 载荷，故没有知识库那样的执行侧防线——挂载即授权。
 *
 * 执行：主进程 MemoryService 进程内直调（配置了嵌入模型走向量检索，否则服务内
 * LIKE 回退，降级在服务侧处理；空结果如实返回，不做静默造数据）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import MemoryService from '../services/memory/MemoryService'

const logger = loggerService.withContext('MemorySearchTool')

export const name = 'tool-memory-search'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  "Search the user's long-term memory for facts and preferences recorded in past conversations. Use it when the " +
  'question may depend on what the user told you before. Send a focused query. Results come back as numbered ' +
  'memories, most recent first. If nothing is relevant, say so.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description: DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The search query. Rephrase and retry if the first results are weak.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            results: { type: 'number', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const query = String(args.query ?? '').trim()
        if (query.length === 0) {
          throw new Error('memory_search: empty query')
        }
        const service = MemoryService.getInstance()
        const found = await service.search(query, { limit: 5 })
        const memories = found.memories ?? []
        const text =
          memories.length === 0
            ? `No long-term memories match "${query}".`
            : [
                `Long-term memories matching "${query}" (most recent first):`,
                ...memories.map((item, index) => `[${index + 1}] ${item.memory}`),
                'These are facts the user shared in past conversations. Use them for personal context only.'
              ].join('\n')
        logger.info(`memory_search: "${query}" -> ${memories.length} hit(s)`)
        return { query, results: memories.length, text }
      }
    })
  )
}
