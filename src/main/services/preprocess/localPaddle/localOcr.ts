/**
 * LocalPaddle OCR 主进程编排（v0.4.4 收编；v0.4.4-1 常驻 worker + 页级并发 + 打断交缓存）。
 *
 * 事故背景：1436 页 PDF 在主进程逐页推理数小时且独占主线程 → 窗口冻结（真机实锤）。
 * 推理在 utilityProcess 子进程（localOcrWorker.ts）——worker_threads 加载
 * onnxruntime/sharp = 整进程 0xC0000005（实测），utility 子进程崩溃被隔离。
 *
 * **v0.4.4-1 常驻 + 并发（用户裁定）**：
 * - **常驻 worker**：句柄跨解析复用，热模型跨本保留（省 ~15s/本冷加载）；worker
 *   5 分钟无消息自退，主进程静默接管、下次解析重 fork。stdout/stderr/message/exit
 *   在 fork 时挂**一次**（每解析挂会泄漏监听），经模块级派发器路由给当前解析。
 * - **页级并发**：信用窗（window = 并发数，默认 5 / 上限 20——用户实测 CPU 跑不满，
 *   串行循环里光栅化/sharp/推理互相空转）；页完成乱序，拼装按页号。
 * - **取消不杀进程**：预算/中止发 {type:'cancel'}，worker 停循环、热模型留给下一本；
 *   解析 promise 走**打断交缓存**（已完成页 + 截断说明，与视觉路径同语义；
 *   零完成照旧拒绝）。单页识别失败 = 废整本、不加 retry（用户裁定）。
 * - **解析队列**：编排层串行化（并发调用从"互踩 activeProcess"的隐性 bug 变排队）。
 * - terminate 契约不变：删模型 kill 常驻 worker 释放文件句柄（Windows unlink 前置）。
 *
 * 时间预算：工具路径 8 分钟 / 知识库摄取 Infinity，经 signal 传入（preprocessChannel）。
 * 子进程 stderr/stdout 接日志（stdio 'pipe'）：崩溃栈可见性。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import { app, utilityProcess } from 'electron'

import { isPaddleModelReady, paddleModelPaths } from './modelStore'

const logger = loggerService.withContext('LocalPaddleOcr')

/** 光栅化倍率：PDF 用户空间 72dpi，3x ≈ 216dpi——PP-OCRv6 解析正文够用且页图不过大。 */
const RENDER_SCALE = 3

/** 页级并发缺省（用户裁定 5：实测 CPU 跑不满，串行循环三段互相空转）与上限。 */
export const DEFAULT_LOCAL_OCR_CONCURRENCY = 5
export const MAX_LOCAL_OCR_CONCURRENCY = 20

export interface LocalOcrOptions {
  /** 页级并发数（1..20）；缺省 = DEFAULT_LOCAL_OCR_CONCURRENCY。 */
  concurrency?: number
  /** GPU 加速（DirectML/CoreML，失败自动回退 CPU）；缺省开。 */
  gpuAcceleration?: boolean
}

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

interface WorkerCancelledMessage {
  type: 'cancelled'
  pagesDone: number
}

type WorkerLogMessage = { type: 'log'; message: string }
type WorkerErrorMessage = { type: 'error'; message: string }
type WorkerOutgoingMessage =
  | WorkerPageMessage
  | WorkerDoneMessage
  | WorkerCancelledMessage
  | WorkerLogMessage
  | WorkerErrorMessage

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
 * 常驻 worker 句柄（跨解析复用）。stdout/stderr/message/exit 监听 fork 时挂一次，
 * 消息经 `currentDispatch` 路由给在跑的解析；exit 时置空句柄并通知当前解析
 * （空闲退出无在跑解析 = 静默）。
 */
let worker: UtilityProcessLike | null = null
let workerDispatch: ((message: WorkerOutgoingMessage) => void) | null = null
let workerExited: (() => void) | null = null

/** 终止常驻 worker 并等待真正退出（删模型前置：Windows 打开句柄会让 unlink 失败）。
 *  在跑的解析经 exit 事件照常收到 "exited unexpectedly" 拒绝（workerExited 不在此清，
 *  清了在途解析就永远收不到通知而悬挂）。 */
export async function terminateActiveOcrProcess(): Promise<void> {
  const child = worker
  if (child === null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  worker = null
  child.kill()
  await exited
}

/** 同步终止常驻 worker（app before-quit 释放 onnxruntime/PaddleOCR 句柄）。在跑的解析
 *  不再结算——进程退出即终点，调用方不等待。
 *  为什么需要它（v1 二轮审查 m2-03）：该 worker 加载 onnxruntime + OCR 模型（数百 MB），
 *  空闲 5 分钟才自退；解析后 5 分钟内退出应用会留下残留子进程。此前只有删模型路径会终止它。 */
export function disposeOcrWorker(): void {
  const child = worker
  if (child === null) return
  worker = null
  workerDispatch = null
  workerExited = null
  child.kill()
}

function acquireWorker(): UtilityProcessLike {
  if (worker !== null) return worker
  const workerPath = join(app.getAppPath(), 'out', 'main', 'localOcrWorker.js')
  if (!existsSync(workerPath)) {
    // 产物缺失 = 构建/打包缺口（构建面由 after-pack 断言挡；此处 fail-loud 不留 stderr 猜谜）。
    throw new Error(`local OCR worker bundle is missing at ${workerPath} (build/packaging gap)`)
  }
  const child: UtilityProcessLike = utilityProcess.fork(workerPath, [], {
    serviceName: 'localOcrWorker',
    stdio: 'pipe'
  })
  child.stdout?.on('data', (chunk: unknown) => {
    logger.info(`local OCR worker stdout: ${String(chunk).trim()}`)
  })
  child.stderr?.on('data', (chunk: unknown) => {
    // stderr 降为 warn（v0.4.4-1）：ORT 的 EP 分配警告（DML 会话创建期的正常
    // 告警）走 stderr，ERROR 面不该被它污染；真崩溃有 exit 事件 + 解析拒绝双
    // 通道在 ERROR 面兜底，forensics 不受损。
    logger.warn(`local OCR worker stderr: ${String(chunk).trim()}`)
  })
  child.on('message', (raw: unknown) => {
    workerDispatch?.(raw as WorkerOutgoingMessage)
  })
  child.on('exit', (code: number) => {
    logger.info(`local OCR worker exited (code ${code})`)
    worker = null
    const notify = workerExited
    workerDispatch = null
    workerExited = null
    notify?.()
  })
  worker = child
  return child
}

/**
 * 整本 PDF 逐页 OCR。入口先查模型就绪（避免起子进程后才发现没模型）；解析队列
 * 串行化（并发调用排队，不互踩）；被打断交缓存（与视觉路径同语义）。
 */
export async function runLocalOcr(
  filePath: string,
  options: LocalOcrOptions = {},
  signal?: AbortSignal
): Promise<string> {
  if (!isPaddleModelReady()) {
    throw new Error('local OCR model is not downloaded (设置 → 文档处理 → LocalPaddle → 下载模型)')
  }
  // 解析队列：同一时刻至多一个 run 在 worker 上（并发调用排队不互踩）。
  return parseQueue.add(() => runOnWorker(filePath, options, signal))
}

/** 模块级解析队列（串行化跨调用；空闲时同步起步保持"调用即 fork"的旧语义，忙碌才排队）。 */
const parseQueue: { add<T>(task: () => Promise<T>): Promise<T> } = (() => {
  let pending: Promise<unknown> | null = null
  return {
    add<T>(task: () => Promise<T>): Promise<T> {
      if (pending === null) {
        const next = task()
        pending = next
          .catch(() => undefined)
          .finally(() => {
            pending = null
          })
        return next
      }
      const next = pending.then(task, task)
      pending = next
        .catch(() => undefined)
        .finally(() => {
          pending = null
        })
      return next
    }
  }
})()

async function runOnWorker(
  filePath: string,
  options: LocalOcrOptions,
  signal: AbortSignal | undefined
): Promise<string> {
  const rawConcurrency = options.concurrency ?? DEFAULT_LOCAL_OCR_CONCURRENCY
  const concurrency = Math.min(
    MAX_LOCAL_OCR_CONCURRENCY,
    Math.max(1, Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : DEFAULT_LOCAL_OCR_CONCURRENCY)
  )
  const child = acquireWorker()

  return new Promise<string>((resolve, reject) => {
    const pages = new Map<number, string>()
    const inflight = new Set<Promise<void>>()
    let totalPagesSeen = 0
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
      if (workerDispatch === dispatch) workerDispatch = null
      if (workerExited === notifyExit) workerExited = null
      // v1 二轮审查 m2-26：此处原有 `controller.abort()`，但 `controller.signal` 全链
      // 没有任何消费者——真正的打断链是「外部 signal → 发 `{type:'cancel'}` 给 worker」，
      // 死代码会让人误以为这里有第二条中断路径，故删除。
      fn()
    }

    const assemble = (): string =>
      [...pages.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join('\n\n')

    /** 结算前排空在途页（信用窗下 worker 跑在消费前面，done/exit 时页可能还在途）。 */
    const drainInflight = (): Promise<void> => Promise.allSettled([...inflight]).then(() => undefined)

    /** 打断交缓存：已完成页按序交回 + 截断说明；零完成报错。 */
    const onInterrupted = (): void => {
      void drainInflight().then(() => {
        const pagesDone = pages.size
        finish(() => {
          if (pagesDone > 0) {
            const note = `[Local OCR interrupted at page ${pagesDone} of ${totalPagesSeen} — time budget exhausted or operation cancelled; the text above covers completed pages only.]`
            resolve(`${assemble()}\n\n${note}`)
          } else {
            reject(signal?.reason ?? new Error('local OCR aborted'))
          }
        })
      })
    }

    const dispatch = (message: WorkerOutgoingMessage): void => {
      if (settled) return
      if (message.type === 'log') {
        logger.info(message.message)
      } else if (message.type === 'page') {
        totalPagesSeen = message.totalPages
        void consumePage(message)
      } else if (message.type === 'done') {
        void drainInflight().then(() => {
          if (settled) return
          if (pages.size === 0) {
            finish(() => reject(new Error('local OCR produced no text — pages may be blank or unreadable')))
          } else {
            finish(() => resolve(assemble()))
          }
        })
      } else if (message.type === 'cancelled') {
        // cancel 的收口（onInterrupted 已 settle 时为 no-op）——防御性容错。
        void drainInflight().then(() => {
          if (!settled) finish(() => reject(new Error('local OCR cancelled')))
        })
      } else if (message.type === 'error') {
        finish(() => reject(new Error(message.message)))
      }
    }

    const notifyExit = (): void => {
      void drainInflight().then(() => {
        if (!settled) finish(() => reject(new Error('local OCR worker exited unexpectedly')))
      })
    }

    const consumePage = (message: WorkerPageMessage): Promise<void> => {
      const task = (async () => {
        // 识别结果不经临时文件直入 map；空页（光栅化不出）贡献空文本不拖垮整本。
        if (message.text.length > 0) pages.set(message.page, message.text)
        logger.info(`local OCR: page ${message.page}/${message.totalPages}`)
      })()
      inflight.add(task)
      void task.catch(() => undefined).finally(() => inflight.delete(task))
      // 本地页无网络等待：消费即结算，回一信让 worker 继续光栅化下一页。
      if (!settled) child.postMessage({ type: 'next' })
      return task
    }

    const onAbort = (): void => {
      child.postMessage({ type: 'cancel' })
      onInterrupted()
    }

    workerDispatch = dispatch
    workerExited = notifyExit

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    // 已中止（零完成拒绝已结算）：不再向 worker 投递任务（cancel 先于 job 会把
    // cancelled 重置回去，job 就漏跑了）。
    if (settled) return

    child.postMessage({
      type: 'job',
      pdfPath: filePath,
      scale: RENDER_SCALE,
      window: concurrency,
      gpu: options.gpuAcceleration !== false,
      modelPaths: paddleModelPaths()
    })
  })
}
