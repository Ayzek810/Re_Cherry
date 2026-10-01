/**
 * 视觉模型文档解析编排（v0.4.4）：文档处理通道 vision-model 条目的执行缝。
 *
 * 链路：utility 子进程逐页光栅化（visionWorker）→ 主进程逐页交 lightVisionDocument
 *（OpenAI 兼容多模态 chat，页图 data URL）→ 页文本按序拼装。**页级并发**（用户裁定：
 * 默认 8、上限 20）：worker 按信用窗放行页图（job.window = 并发数，结算一页回一信），
 * 在途模型调用 ≤ 并发数，内存上界 = 并发 × 一页图；页完成顺序乱序，拼装按页号排序。
 *
 * 失败/打断语义（用户裁定 + v1 修订）：
 * - 单页模型调用失败 = 整本拒绝，不加 retry —— **例外**：传输层失败（请求超时/连接被断，
 *   `LightVisionRequestError.retriable`）重试一次。页图识图是只读幂等操作，对端掐断重发没有副作用；
 *   HTTP 状态码与响应形状错误不重试（那是服务端的明确答复）。
 * - **失败必须落盘**（v1）：单页失败、worker 报错、worker 意外退出、零页可交四条路都记 warn
 *   并带上 cause 链——旧实现三条路一行日志都没有，只能靠翻内核库反推"拉不起来"。
 * - **打断交缓存**：预算到点 / 用户中止时，已完成页按序拼装 + 末尾附模型可见的
 *   截断说明，作为工具结果交回（一页未成则照旧拒绝）。
 * - 空页（光栅化不出 / 模型回空）不拖垮整本。
 * 页图不落盘、不入内核附件仓——一次请求的中间产物，用完即弃。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import { lightVisionDocument, LightVisionRequestError } from '@main/kernel/lightLlmModalities'
import { app, utilityProcess } from 'electron'

const logger = loggerService.withContext('VisionDocument')

/** 光栅化倍率：144dpi——视觉模型不需要 PP-OCR 的 216dpi，页图体积换取网络与费用。 */
const RENDER_SCALE = 2

/** 单页尝试次数上限：首次 + 传输层失败重试一次（v1）。 */
const MAX_PAGE_ATTEMPTS = 2

/** 页级并发缺省值（用户裁定 8）；面板可调，上限 40（用户裁定：20 仍是节点，40 为新最大值）。 */
export const DEFAULT_VISION_CONCURRENCY = 8
export const MAX_VISION_CONCURRENCY = 40

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
  /** 页级并发数（1..20）；缺省 = DEFAULT_VISION_CONCURRENCY。 */
  concurrency?: number
}

interface WorkerPageMessage {
  type: 'page'
  page: number
  totalPages: number
  mediaType: 'image/png' | 'image/jpeg'
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

/** 逐页光栅化 + 逐页转写；单页模型调用失败即整本拒绝，被打断时交回已完成页。 */
export async function runVisionDocumentParse(
  filePath: string,
  config: VisionDocumentConfig,
  signal?: AbortSignal
): Promise<string> {
  const workerPath = visionWorkerPath()
  if (!existsSync(workerPath)) {
    throw new Error(`vision document worker bundle is missing at ${workerPath} (build/packaging gap)`)
  }
  const rawConcurrency = config.concurrency ?? DEFAULT_VISION_CONCURRENCY
  const concurrency = Math.min(
    MAX_VISION_CONCURRENCY,
    Math.max(1, Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : DEFAULT_VISION_CONCURRENCY)
  )
  const child: UtilityProcessLike = utilityProcess.fork(workerPath, [], {
    serviceName: 'visionDocumentWorker',
    stdio: 'pipe'
  })
  child.stdout?.on('data', (chunk: unknown) => {
    logger.info(`vision document worker stdout: ${String(chunk).trim()}`)
  })
  child.stderr?.on('data', (chunk: unknown) => {
    // stderr 走 warn（与 localOcr 同判据）：库级警告不污染 ERROR 面。
    logger.warn(`vision document worker stderr: ${String(chunk).trim()}`)
  })

  // 内部中断链：外部 signal（预算/用户中止）与 finish（单页失败）都汇聚到这里，
  // 一次性掐掉全部在途模型请求；打断路径用它区分「该交缓存」和「该报错」。
  const controller = new AbortController()

  return new Promise<string>((resolve, reject) => {
    const pages = new Map<number, string>()
    const inflight = new Set<Promise<void>>()
    let totalPagesSeen = 0
    let settled = false
    let onAbort: (() => void) | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
      controller.abort()
      child.kill()
      fn()
    }

    const assemble = (): string =>
      [...pages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join('\n\n')

    /**
     * 结算前排空在途页：信用窗下 worker 会跑在消费前面（模型调用在途时 `done` /
     * `exit` 就可能到达），必须等在途消费全部落地再读 pages——否则大书解析出
     * 前几页就被当成"完成"（Probe G 实锤）。
     */
    const drainInflight = (): Promise<void> => Promise.allSettled([...inflight]).then(() => undefined)

    /** 打断交缓存（用户裁定）：预算到点 / 用户中止时已完成页按序拼装交回，零完成则报错。 */
    const onInterrupted = (): void => {
      // 中断是否真的传到视觉这条腿（info）：证明"中止源生效"，与内核无关。
      logger.info(
        `vision parse interrupted at ${pages.size}/${totalPagesSeen} page(s); reason=${String(signal?.reason ?? 'n/a')}`
      )
      void drainInflight().then(() => {
        const pagesDone = pages.size
        finish(() => {
          if (pagesDone > 0) {
            const note = `[Vision document parse interrupted at page ${pagesDone} of ${totalPagesSeen} — time budget exhausted or operation cancelled; the text above covers completed pages only.]`
            resolve(`${assemble()}\n\n${note}`)
          } else {
            reject(signal?.reason ?? new Error('vision document parse aborted'))
          }
        })
      })
    }

    /** 一页的消费：模型调用 → 结算回一信；单页失败 = 整本拒绝（传输层失败重试一次，v1）。 */
    const consumePage = (message: WorkerPageMessage): Promise<void> => {
      const task = (async () => {
        if (message.data.length === 0) {
          logger.warn(`vision document: page ${message.page}/${message.totalPages} produced no image (skipped)`)
          if (!settled) child.postMessage({ type: 'next' })
          return
        }
        for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
          const startedAt = performance.now()
          try {
            const text = (
              await lightVisionDocument(
                {
                  providerId: config.provider,
                  modelId: config.model,
                  prompt: VISION_DOCUMENT_PROMPT,
                  images: [{ mediaType: message.mediaType, data: message.data }]
                },
                controller.signal
              )
            ).trim()
            if (text.length > 0) pages.set(message.page, text)
            logger.info(
              `vision document: page ${message.page}/${message.totalPages} → ${text.length} chars ` +
                `(image ${Math.round((message.data.length * 3) / 4 / 1024)}KB as ${message.mediaType}, ` +
                `${Math.round(performance.now() - startedAt)}ms, attempt ${attempt})`
            )
            if (!settled) child.postMessage({ type: 'next' })
            return
          } catch (error) {
            // 自身打断引起的请求异常由 onInterrupted 结算，这里只处理真实失败。
            if (controller.signal.aborted) return
            const elapsed = Math.round(performance.now() - startedAt)
            const detail = error instanceof Error ? error.message : String(error)
            if (error instanceof LightVisionRequestError && error.retriable && attempt < MAX_PAGE_ATTEMPTS) {
              logger.warn(
                `vision document: page ${message.page}/${message.totalPages} attempt ${attempt} failed after ` +
                  `${elapsed}ms — retrying once: ${detail}`
              )
              continue
            }
            logger.warn(
              `vision document: page ${message.page}/${message.totalPages} failed after ${elapsed}ms ` +
                `(attempt ${attempt}/${MAX_PAGE_ATTEMPTS}): ${detail}`
            )
            finish(() => reject(error instanceof Error ? error : new Error(String(error))))
            return
          }
        }
      })()
      inflight.add(task)
      void task.catch(() => undefined).finally(() => inflight.delete(task))
      return task
    }

    child.on('message', (raw: unknown) => {
      if (settled) return
      const message = raw as WorkerOutgoingMessage
      if (message.type === 'log') {
        logger.info(message.message)
      } else if (message.type === 'page') {
        totalPagesSeen = message.totalPages
        void consumePage(message)
      } else if (message.type === 'done') {
        // worker 可能跑在消费前面（信用窗）：先排空在途页再结算。
        void drainInflight().then(() => {
          if (settled) return
          if (pages.size === 0) {
            logger.warn(`vision document: worker finished with 0 text page(s) of ${message.totalPages} — rejecting`)
            finish(() => reject(new Error('vision document parse produced no text — pages may be blank or unreadable')))
          } else {
            finish(() => resolve(assemble()))
          }
        })
      } else if (message.type === 'error') {
        logger.warn(`vision document: worker reported an error — ${message.message}`)
        finish(() => reject(new Error(message.message)))
      }
    })
    child.on('exit', (code: number) => {
      // 自然退出也可能跑在在途消费前面（信用窗）：先排空再判意外退出。
      void drainInflight().then(() => {
        if (!settled) {
          logger.warn(
            `vision document: worker exited unexpectedly (code ${code}) after ${pages.size}/${totalPagesSeen} page(s)`
          )
          finish(() => reject(new Error(`vision document worker exited unexpectedly (code ${code})`)))
        }
      })
    })

    if (signal !== undefined) {
      onAbort = (): void => onInterrupted()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.postMessage({ pdfPath: filePath, scale: RENDER_SCALE, window: concurrency })
  })
}
