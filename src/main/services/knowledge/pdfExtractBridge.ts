/**
 * PDF 文本层抽取的常驻 worker 桥（v0.4.4-2，§7.20 挂账清偿）：
 * 主进程不再跑 pdf.js（§7.20「直读 PDF 卡窗口」实锤）——PDF 抽取整体进
 * utilityProcess（pdfExtractWorker.ts），经 installPdfWorkerExtractor 注入
 * extractors 的可插拔 PDF 缝（vitest 不安装 → 引擎测试保持进程内真跑）。
 *
 * 生命周期（与 localOcr 常驻 worker 同款）：句柄跨请求复用；stdout/stderr/
 * message/exit fork 时挂一次经派发器路由；5 分钟空闲自退由 worker 侧负责，
 * 主进程对 exit 静默接管（句柄置空，下次抽取重 fork）；**abort = kill**（单次
 * getText 不可分页中断，进程终止即取消；pdf-parse 模块重初始化 ~300ms，无热态
 * 损失）；抽取按 id 关联，串行队列保证同一时刻至多一个在途请求。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import { app, utilityProcess } from 'electron'

const logger = loggerService.withContext('PdfExtractWorker')

interface UtilityProcessLike {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  once(event: 'exit', listener: (code: number) => void): unknown
  kill(): void
}

interface PendingRequest {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

let worker: UtilityProcessLike | null = null
let workerDispatch: ((message: { id: number; type?: string; text?: string; message?: string }) => void) | null = null
let pending: PendingRequest | null = null
let nextId = 1

function acquireWorker(): UtilityProcessLike {
  if (worker !== null) return worker
  const workerPath = join(app.getAppPath(), 'out', 'main', 'pdfExtractWorker.js')
  if (!existsSync(workerPath)) {
    // 产物缺失 = 构建/打包缺口（构建面由 after-pack 断言挡；此处 fail-loud）。
    throw new Error(`pdf extract worker bundle is missing at ${workerPath} (build/packaging gap)`)
  }
  const child: UtilityProcessLike = utilityProcess.fork(workerPath, [], {
    serviceName: 'pdfExtractWorker',
    stdio: 'pipe'
  })
  child.stdout?.on('data', (chunk: unknown) => {
    logger.info(`pdf extract worker stdout: ${String(chunk).trim()}`)
  })
  child.stderr?.on('data', (chunk: unknown) => {
    // stderr 走 WARN（与 localOcr 同判据）：库级警告不污染 ERROR 面。
    logger.warn(`pdf extract worker stderr: ${String(chunk).trim()}`)
  })
  child.on('message', (raw: unknown) => {
    workerDispatch?.(raw as { id: number; type?: string; text?: string; message?: string })
  })
  child.on('exit', (code: number) => {
    logger.info(`pdf extract worker exited (code ${code})`)
    worker = null
    const notify = pending
    workerDispatch = null
    pending = null
    notify?.reject(new Error(`pdf extract worker exited unexpectedly (code ${code})`))
  })
  worker = child
  return child
}

function killWorker(): void {
  const child = worker
  if (child === null) return
  worker = null
  workerDispatch = null
  pending = null
  child.kill()
}

/** 终止常驻 worker 并清空在途请求（app before-quit 释放 PDF 文件句柄；测试生命周期复用）。
 *  在跑的抽取 promise 不再结算（进程退出即终点）——调用方不等待。 */
export function disposePdfExtractWorker(): void {
  const child = worker
  if (child === null) return
  worker = null
  workerDispatch = null
  pending = null
  child.kill()
}

/** 单次抽取（串行队列；abort = kill worker，pdf-parse 模块下次按需重建）。 */
export async function extractPdfViaWorker(filePath: string, signal?: AbortSignal): Promise<string> {
  if (pending !== null) {
    throw new Error('pdf extract worker is busy (serial queue violation)')
  }
  const child = acquireWorker()
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => {
      const reason = signal?.reason ?? new Error('pdf extraction aborted')
      killWorker()
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    const onAbortWrapped = (): void => {
      signal?.removeEventListener('abort', onAbort)
      onAbort()
    }

    workerDispatch = (message) => {
      if (message.id !== id) return
      if (message.type === 'result') {
        signal?.removeEventListener('abort', onAbort)
        pending = null
        resolve(message.text ?? '')
      } else if (message.type === 'error') {
        signal?.removeEventListener('abort', onAbort)
        pending = null
        reject(new Error(message.message ?? 'pdf extract worker error'))
      }
    }
    pending = {
      resolve: (text) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(text)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    }

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbortWrapped, { once: true })
      if (signal.aborted) {
        onAbortWrapped()
        return
      }
    }

    child.postMessage({ type: 'extract', id, filePath })
  })
}

let installed = false

/**
 * 把「PDF 抽取走常驻 worker」注入 extractors 的可插拔缝。仅应用 boot 时调用一次
 *（vitest 不装——引擎测试保持进程内真跑）；未安装时 extractFromFile 的 PDF 分支
 * 走进程内 pdf-parse（行为与 v0.4.4-1 一致）。
 */
export function installPdfWorkerExtractor(): void {
  if (installed) return
  installed = true
  // 延迟 import 断环：extractors（引擎）不反向依赖本桥，boot 侧单向注入。
  void import('./extractors').then(({ setPdfExtractorOverride }) => {
    setPdfExtractorOverride((filePath, _source, signal) => extractPdfViaWorker(filePath, signal))
    logger.info('pdf extract worker override installed')
  })
}
