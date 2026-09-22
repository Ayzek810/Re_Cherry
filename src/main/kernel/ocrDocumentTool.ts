/**
 * ocr_document 内核 builtin 工具（2026-09-22 用户裁决：OCR 独立成内置工具）。
 *
 * 与 read_document 分体：read_document 直读（PDF 文本层，无扫描件检测）；本工具
 * 整本走文档处理通道（用户第三轮裁决："我让你把这个也挂进文档处理通道是干什么
 * 的"——按 设置 → 文档处理 的服务商路由：云端五家云解析、LocalPaddle 本机 OCR；
 * 时间预算 8 分钟，文本/页数截断上限已按用户裁决删除）。何时用由模型自行判断
 * （用户原话："模型应该有能力在打开它的情况下自己判断什么时候使用它"）——典型
 * 时机：read_document 文本层空/乱、或用户明确要 OCR。
 *
 * 挂载：渲染层 messageThunk 在触发消息带文件附件的轮把 'ocr_document' 并入
 * builtinTools（与 read_document 同轮）；文档名清单进 RuntimeContextProjection
 * 快照节（cherry:documents）。未登记/未配置时执行侧如实报可行动错误，不静默降级。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'

const logger = loggerService.withContext('OcrDocumentTool')

export const name = 'tool-ocr-document'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Read an attached PDF by processing it through the document-processing channel (设置 → 文档处理): the ' +
  'configured provider (MinerU, Doc2x, Mistral, Open MinerU, PaddleOCR, or LocalPaddle for on-device OCR) ' +
  'parses the whole document and returns its full text. Use this when read_document reports that a PDF has ' +
  'no meaningful text layer (scanned document), when the extracted text looks empty or garbled, or when the ' +
  'user explicitly asks for OCR. Large PDFs can take several minutes (8-minute budget). If no provider is ' +
  'configured yet, an actionable error is returned. PDF only; the document must be attached to this ' +
  'conversation turn. Pass the document name exactly as listed under "Attached documents".'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ocr_document',
      description: DESCRIPTION,
      parameters: {
        document: {
          type: 'string',
          required: true,
          description: 'The document name exactly as listed in the "Attached documents" context note.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            document: { type: 'string', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      // OCR 是重活（单活子进程 + 分钟到小时级耗时），不并发安全——DSH 串行执行。
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const documentName = String(args.document ?? '').trim()
        if (documentName.length === 0) {
          throw new Error('ocr_document: empty document name')
        }
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('ocr_document: no active conversation turn')
        }
        const result = await knowledgeService.ocrTurnDocument(topicId, documentName)
        logger.info(`ocr_document: "${documentName}" -> ${result.text.length} chars`)
        return { document: result.name, text: result.text }
      }
    })
  )
}
