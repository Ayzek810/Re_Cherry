/**
 * read_document 内核 builtin 工具（聊天中文档阅读处理）。
 *
 * 渲染层 messageThunk 在触发消息带文件附件（FILE 块）的轮把 'read_document' 并入
 * builtinTools 并随发送参数登记文档清单；可用文档名列表进 RuntimeContextProjection
 * 快照节（cherry:documents，dsh 去重注入逐轮新鲜）；模型按名调用本工具读全文。
 * 上游 CS_V1 的"发送前把文档内容改写进 user 消息"形态不取——不变量2（改写内容不进
 * 会话日志）。
 *
 * 执行（2026-09-22 用户第二轮裁决：直读为中心）：本文件只是工具缝——处理本体在
 * knowledgeService.readTurnDocument，全部格式走共用引擎（PDF 读文本层；纯文本直读、
 * .doc word-extractor、docx/html 原生 Markdown 管线 mammoth+turndown、office 族
 * officeparser、epub zip→Markdown——全程进程内，零 CLI/Python 前置）。空抽取返回
 * 中性提示，扫描件由模型自行调 ocr_document（同轮裁决：OCR 分体独立）。
 * 原 DocumentService 已删除（b27a0c1）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { knowledgeService } from '../services/knowledge/KnowledgeService'

const logger = loggerService.withContext('DocumentTool')

export const name = 'tool-read-document'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Read the full text of one attached document. Supports text files (txt, md, csv, json, yaml, log), PDFs ' +
  '(text layer), .doc, .docx, .html, .pptx, .xlsx, .odt, .odp, .ods and .epub. Use it when the user asks ' +
  'about the content of an attached document. Pass the document name exactly as shown under "Attached ' +
  'documents". If a PDF returns empty or garbled text, it is probably scanned — use the ocr_document tool.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'read_document',
      description: DESCRIPTION,
      parameters: {
        document: {
          type: 'string',
          required: true,
          description: 'The document name, quoted exactly as listed under "Attached documents".'
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
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const documentName = String(args.document ?? '').trim()
        if (documentName.length === 0) {
          throw new Error('read_document: empty document name')
        }
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('read_document: no active conversation turn')
        }
        const result = await knowledgeService.readTurnDocument(topicId, documentName, exec.signal)
        logger.info(`read_document: "${documentName}" -> ${result.text.length} chars`)
        return { document: result.name, text: result.text }
      }
    })
  )
}
