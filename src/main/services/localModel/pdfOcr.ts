/**
 * PDF → 本地 OCR 主进程编排（v0.3.2 自 CS_V2 local-document 移植）。
 *
 * 2026-09-22 性能事故修复：推理全部挪入 utilityProcess 子进程（ocrWorker.ts）
 * ——此前 1436 页书在主进程逐页推理数小时，主线程被独占、窗口整体冻结（真机
 * 实锤：dev 日志 page 1/1436 + 两次 Renderer killed）。选 utilityProcess 而非
 * worker_threads：本机 worker_threads 里加载 onnxruntime/sharp → 整进程
 * 0xC0000005（实测），utility 子进程原生崩溃被隔离，即"崩溃隔离"落地。
 * 主进程只做编排、部分结果组装、终止。页与页串行（子进程内单推理队列）；读不
 * 出的页贡献空文本而非整体失败（与上游同语义）。输出不带页标记——下游直接切
 * 块嵌入/喂模型，合成页标题会把文档没有的结构写进向量。
 *
 * 预算落点（2026-09-22 三轮澄清）：页数上限与 200k 文本截断上限删除（终局）；
 * 时间预算 8 分钟由 preprocessChannel.parsePdfWithProvider 的 AbortController 施加
 * （工具路径默认；知识库摄取路径传 Infinity = 无预算）。本编排自身无预算——预算
 * 经 signal 传入，abort 即 kill 子进程并拒绝。
 * 子进程 stderr/stdout 接日志（同轮验收事故的长期改进）：worker 崩溃时其栈
 * 经 pipe 进主进程日志——此前 stdio 默认 inherit，安装版里 worker 崩溃原因
 * 彻底不可见，只能对着 "exited unexpectedly (code 1)" 瞎猜。
 */
import { join } from 'node:path'

import { loggerService } from '@logger'
import { utilityProcess } from 'electron'

import { isLocalOcrModelDownloaded, ocrModelPaths } from './ocrPaths'

const logger = loggerService.withContext('PdfOcr')

/** 光栅化倍率：PDF 用户空间 72dpi，3x ≈ 216dpi——PP-OCRv6 解析正文够用且页图不过大。 */
const RENDER_SCALE = 3

interface WorkerPageMessage {
  type: 'page'
  page: number
  totalPages: number
  text: string
}

interface WorkerDoneMessage {
  type: 'done'
  pagesDone: number
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

/** 当前活着的 OCR 子进程——模型删除前必须先终止（Windows 打开句柄会让 unlink 失败）。 */
let activeProcess: UtilityProcessLike | null = null

/** 终止活着的 OCR 子进程（若无则空操作）；等待进程真正退出。 */
export async function terminateActiveOcrProcess(): Promise<void> {
  const child = activeProcess
  if (child === null) return
  activeProcess = null
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  await exited
}

/**
 * 整本 PDF 逐页 OCR。入口先查模型就绪（避免起子进程后才发现没模型）；任务交给
 * utility 子进程，主进程只收敛结果。时间预算（若有）由调用方经 signal 传入——
 * abort 即终止子进程并拒绝（见文件头预算落点）。
 */
export async function ocrPdfFile(filePath: string, signal?: AbortSignal): Promise<string> {
  if (!isLocalOcrModelDownloaded()) {
    throw new Error('local OCR model is not downloaded (设置 → 文档处理 → LocalPaddle → 下载模型)')
  }
  // electron 运行时导出是小写实例 utilityProcess（大写 UtilityProcess 只是类型，
  // 动态解构 `const { UtilityProcess } = await import('electron')` 运行时是
  // undefined——tsgo 静态化后当场抓出；此为该雷的纪念碑）。
  // stdio 'pipe'：worker 的 stdout/stderr 收进主进程日志（崩溃栈可见性，
  // 默认 inherit 在安装版里=丢弃）。
  const child: UtilityProcessLike = utilityProcess.fork(join(__dirname, 'ocrWorker.js'), [], {
    serviceName: 'localOcrWorker',
    stdio: 'pipe'
  })
  activeProcess = child
  child.stdout?.on('data', (chunk: unknown) => {
    logger.info(`local OCR worker stdout: ${String(chunk).trim()}`)
  })
  child.stderr?.on('data', (chunk: unknown) => {
    logger.error(`local OCR worker stderr: ${String(chunk).trim()}`)
  })

  return new Promise<string>((resolve, reject) => {
    const pages = new Map<number, string>()
    let lastPage = 0
    let settled = false
    let onAbort: (() => void) | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
      if (activeProcess === child) activeProcess = null
      child.kill()
      fn()
    }

    const assemble = (): string =>
      [...pages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join('\n\n')

    child.on('message', (raw: unknown) => {
      if (settled) return
      const message = raw as WorkerOutgoingMessage
      if (message.type === 'log') {
        logger.info(message.message)
      } else if (message.type === 'page') {
        lastPage = Math.max(lastPage, message.page)
        if (message.text.length > 0) pages.set(message.page, message.text)
        logger.info(`local OCR: page ${message.page}/${message.totalPages}`)
      } else if (message.type === 'done') {
        if (lastPage === 0) {
          finish(() => reject(new Error('local OCR produced no text — pages may be blank or unreadable')))
        } else {
          finish(() => resolve(assemble()))
        }
      } else if (message.type === 'error') {
        finish(() => reject(new Error(message.message)))
      }
    })
    child.on('exit', (code: number) => {
      if (!settled) finish(() => reject(new Error(`local OCR worker exited unexpectedly (code ${code})`)))
    })

    if (signal !== undefined) {
      onAbort = (): void => finish(() => reject(signal?.reason ?? new Error('local OCR aborted')))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.postMessage({
      pdfPath: filePath,
      scale: RENDER_SCALE,
      modelPaths: ocrModelPaths()
    })
  })
}
