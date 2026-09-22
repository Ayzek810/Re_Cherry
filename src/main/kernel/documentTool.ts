/**
 * read_document 内核 builtin 工具（批次6 聊天中文档阅读处理，roadmap L29）。
 *
 * 渲染层 messageThunk 在触发消息带文件附件（FILE 块）的轮把 'read_document' 并入
 * builtinTools 并随发送参数登记文档清单；可用文档名列表进 RuntimeContextProjection
 * 快照节（cherry:documents，dsh 去重注入逐轮新鲜）；模型按名调用本工具读全文。
 * 上游 CS_V1 的"发送前把文档内容改写进 user 消息"形态不取——不变量2（改写内容不进
 * 会话日志）。
 *
 * 执行（2026-09-22 用户第二轮裁决：直读为中心，"以现在的 markitdown 为中心"）：
 * 本文件只是工具缝——处理本体在 knowledgeService.readTurnDocument，全部格式走
 * 共用引擎（PDF 读文本层 + 密度门；纯文本直读、.doc word-extractor、docx/html
 * 原生 Markdown 管线 mammoth+turndown、pptx/xlsx/odt officeparser 文本——全程
 * 进程内，零 CLI/Python 前置）。扫描件（密度门命中）报错并指引 ocr_document 工具
 * （同轮裁决：OCR 分体独立）。原 DocumentService 已删除（b27a0c1）。
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
  'Read an attached document directly and return its FULL text with no truncation. Everything is handled ' +
  'in-process: PDFs are read from their text layer, plain text files (txt, md, csv, json, yaml, log) are read ' +
  'directly, legacy .doc files use the built-in Word extractor, .docx and .html are converted to Markdown ' +
  'natively (headings, lists and tables preserved), and .pptx/.xlsx/.odt/.odp/.ods/.epub yield text or ' +
  'Markdown. If a PDF yields empty or garbled text it may be a scanned document — the ocr_document tool ' +
  'parses it through the document-processing channel instead. No external tools required. The list of ' +
  'attached documents appears in the conversation context under "Attached documents". Pass the document ' +
  'name exactly as listed. Use this when the user asks about the content of an attached document instead ' +
  'of guessing from the filename.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'read_document',
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
        const result = await knowledgeService.readTurnDocument(topicId, documentName)
        logger.info(`read_document: "${documentName}" -> ${result.text.length} chars`)
        return { document: result.name, text: result.text }
      }
    })
  )
}
