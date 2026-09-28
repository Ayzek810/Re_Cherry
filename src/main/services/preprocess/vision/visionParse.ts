/**
 * 视觉模型文档解析编排（v0.4.4）：文档处理通道 vision-model 条目的执行缝。
 *
 * 链路：utility 子进程逐页光栅化（visionWorker）→ 主进程逐页交 lightVisionDocument
 *（OpenAI 兼容多模态 chat，页图 data URL）→ 页文本按序拼装。页与页**串行**：
 * ping-pong 协议（主进程处理完一页才放行下一页）把内存钉死在"一页图 + 一页文本"，
 * 串行也天然避开服务商并发限流。空页（光栅化不出 / 模型回空）不拖垮整本。
 *
 * 预算落点：与 local-paddle 同款——时间预算由 preprocessChannel.parsePdfWithProvider
 * 的 AbortController 施加（工具路径 8 分钟；知识库摄取 Infinity），abort 经 signal
 * 同时打断在途 HTTP 请求与光栅化子进程（kill）。
 *
 * 失败语义（诚实面）：模型调用失败 = 服务商失败 → 整本拒绝并上抛（HTTP 细节保留），
 * 不静默降级成空页；整本无文本 → 明确报错（页可能空白或不可读）。
 * 页图不落盘、不入内核附件仓——一次请求的中间产物，用完即弃。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import { lightVisionDocument } from '@main/kernel/lightLlmModalities'
import { app, utilityProcess } from 'electron'

const logger = loggerService.withContext('VisionDocument')

/** 光栅化倍率：144dpi——视觉模型不需要 PP-OCR 的 216dpi，页图体积换取网络与费用。 */
const RENDER_SCALE = 2

/**
 * 转写指令（内置常量，本批不做用户可配）：要求只输出 markdown 正文、保留结构、
 * 公式用 LaTeX、按原文语言、无内容则留空——不夹带评论与代码围栏（模型爱加
 * ```markdown 围栏，会给下游 markdown 解析平添噪声）。
 */
export const VISION_DOCUMENT_PROMPT = [
  'You are a document transcription engine. Transcribe the attached document page image into faithful Markdown.',
  'Rules:',
  '- Output only the transcribed content: no commentary, no preamble, no surrounding code fences.',
  '- Preserve reading order and structure: headings, paragraphs, lists, and tables (as GitHub-flavoured Markdown tables).',
  '- Render mathematical formulas as LaTeX ($...$ inline, $$...$$ display).',
  '- Transcribe text exactly as it appears, keeping its original language (Chinese stays Chinese, and so on).',
  '- Keep figure and table captions together with their content.',
  '- If the page has no readable text (blank page, pure image), output nothing at all.'
].join('\n')

export interface VisionDocumentConfig {
  provider: string
  model: string
}

interface WorkerPageMessage {
  type: 'page'
  page: number
  totalPages: number
  mediaType: 'image/png'
  data: string
}

interface WorkerDoneMessage {
  type: 'done'
  totalPages: number
}

type WorkerLogMessage = { type: 'log'; message: string }
type WorkerErrorMessage = { type: 'error'; message: string }
type WorkerOutgoingMessage = WorkerPageMessage | WorkerDoneMessage | WorkerLogMessage | WorkerErrorMessage

interface UtilityProcessLike {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): void
}

/**
 * 光栅化 worker 产物路径。**禁止用 __dirname 推导**（2026-09-28 编排层 fork 路径
 * 回归的同一判据）：编排层会被 rollup 拆进共享 chunk，chunk 里的 __dirname 不是
 * out/main；锚定 app 根（dev = 仓库根，打包 = app.asar 根，utilityProcess 支持从
 * asar 路径 fork，probe-e 实证）。
 */
export function visionWorkerPath(): string {
  return join(app.getAppPath(), 'out', 'main', 'visionWorker.js')
}

/** 逐页光栅化 + 逐页转写；任一页的模型调用失败即整本拒绝。 */
export async function runVisionDocumentParse(
  filePath: string,
  config: VisionDocumentConfig,
  signal?: AbortSignal
): Promise<string> {
  const workerPath = visionWorkerPath()
  if (!existsSync(workerPath)) {
    throw new Error(`vision document worker bundle is missing at ${workerPath} (build/packaging gap)`)
  }
  const child: UtilityProcessLike = utilityProcess.fork(workerPath, [], {
    serviceName: 'visionDocumentWorker',
    stdio: 'pipe'
  })
  child.stdout?.on('data', (chunk: unknown) => {
    logger.info(`vision document worker stdout: ${String(chunk).trim()}`)
  })
  child.stderr?.on('data', (chunk: unknown) => {
    logger.error(`vision document worker stderr: ${String(chunk).trim()}`)
  })

  return new Promise<string>((resolve, reject) => {
    const pages = new Map<number, string>()
    let settled = false
    let onAbort: (() => void) | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
      child.kill()
      fn()
    }

    const assemble = (): string =>
      [...pages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join('\n\n')

    /** 一页的完整消费：模型调用（含失败）→ 放行下一页；失败即整本拒绝。 */
    const consumePage = async (message: WorkerPageMessage): Promise<void> => {
      try {
        if (message.data.length > 0) {
          const text = (
            await lightVisionDocument(
              {
                providerId: config.provider,
                modelId: config.model,
                prompt: VISION_DOCUMENT_PROMPT,
                images: [{ mediaType: message.mediaType, data: message.data }]
              },
              signal
            )
          ).trim()
          if (text.length > 0) pages.set(message.page, text)
          logger.info(`vision document: page ${message.page}/${message.totalPages} → ${text.length} chars`)
        } else {
          logger.warn(`vision document: page ${message.page}/${message.totalPages} produced no image (skipped)`)
        }
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
        return
      }
      if (!settled) child.postMessage({ type: 'next' })
    }

    child.on('message', (raw: unknown) => {
      if (settled) return
      const message = raw as WorkerOutgoingMessage
      if (message.type === 'log') {
        logger.info(message.message)
      } else if (message.type === 'page') {
        // 串行由协议保证：worker 收不到 'next' 不会发下一页。
        void consumePage(message)
      } else if (message.type === 'done') {
        // 'done' 只在最后一页的 'next' 之后到达——此时全部页已消费完（协议保证）。
        if (pages.size === 0) {
          finish(() => reject(new Error('vision document parse produced no text — pages may be blank or unreadable')))
        } else {
          finish(() => resolve(assemble()))
        }
      } else if (message.type === 'error') {
        finish(() => reject(new Error(message.message)))
      }
    })
    child.on('exit', (code: number) => {
      if (!settled) finish(() => reject(new Error(`vision document worker exited unexpectedly (code ${code})`)))
    })

    if (signal !== undefined) {
      onAbort = (): void => finish(() => reject(signal?.reason ?? new Error('vision document parse aborted')))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.postMessage({ pdfPath: filePath, scale: RENDER_SCALE })
  })
}
