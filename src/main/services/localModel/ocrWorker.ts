/**
 * LocalPaddle OCR utility process 入口（v0.3.2 性能事故修复，2026-09-22）。
 *
 * 事故：一切 PDF → OCR 的路由下，1436 页 PDF 在主进程逐页推理 ≈ 数小时，
 * 主线程被独占 → 窗口整体冻结（真机实锤：dev 日志 `local OCR: page 1/1436`
 * 起步每页 5~25s + 当晚两次 `Renderer process killed`）。
 *
 * 本进程承接全套重活：pdf-parse 逐页光栅化 → sharp 预处理 → ppu-paddle-ocr
 * 推理。主进程（pdfOcr.ts）只做编排与终止——OCR 结果一字不变。
 *
 * **为什么是 utilityProcess 而不是 worker_threads**：本机实测 worker_threads
 * 里加载 onnxruntime/sharp 原生模块 → 整进程 0xC0000005 访问违例（与 vitest
 * threads 池同类的机器级事实，判据同源）；utilityProcess 是独立 Node 子进程
 * （Electron 托管），原生崩溃被隔离在子进程内，正是"崩溃隔离"的落地形态。
 *
 * **parentPort 的获取途径（2026-09-22 验收轮真机实锤，判据级）**：utility
 * 进程里 `require('electron')` 运行时只有 `{ net, systemPreferences }`（真实
 * electron 宿主探针实证）——d.ts 里的 `const parentPort` 模块导出在 utility
 * 宿主**不存在**（类型撒谎，tsgo 不设防）；正解是 `process.parentPort`
 * （d.ts Process 增强："A Electron.ParentPort property if this is a
 * UtilityProcess"）。曾用模块导出形态 → 消息处理器从未注册 → worker 静默
 * 空转 → 主进程报 "worker exited unexpectedly"。本文件直接访问
 * process.parentPort（utility 宿主必在；若在非 utility 宿主被 require 会在
 * 顶层抛错退出——fail-loud 优于静默空转）。
 *
 * 纪律（违反即事故）：本文件对 electron 的使用**仅限 process.parentPort**；
 * 禁止 @logger（winston 双进程写同一日志文件会互锁），日志一律经 postMessage
 * 交主进程落盘；模型路径由主进程经消息传入（utility 进程里 app.getPath 不可靠
 * 的形态不依赖）。编译产物 out/main/ocrWorker.js（electron.vite.config 多入口）。
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { PDFParse } from 'pdf-parse'

/** 主进程下发的任务（postMessage 触发 run，全部数据不可从子进程侧自取）。 */
interface OcrWorkerJob {
  pdfPath: string
  scale: number
  modelPaths: { detection: string; recognition: string; charactersDictionary: string }
}

interface PaddleOcrInstance {
  initialize(): Promise<void>
  recognize(image: ArrayBuffer): Promise<{ text: string; lines?: unknown }>
  destroy(): Promise<void>
}

type WorkerMessage =
  | { type: 'log'; message: string }
  | { type: 'page'; page: number; totalPages: number; text: string }
  | { type: 'done'; pagesDone: number; totalPages: number }
  | { type: 'error'; message: string }

const parentPort = process.parentPort
const post = (message: WorkerMessage): void => parentPort?.postMessage(message)
const log = (message: string): void => post({ type: 'log', message })

/** ppu-paddle-ocr 的结构化最小面（类类型导出形态不在 fork 控制内，按用法收窄）。 */
let cachedService: Promise<PaddleOcrInstance> | null = null
/** 串行闸：识别请求依次执行（单个失败不堵塞后续）。 */
let queue: Promise<unknown> = Promise.resolve()

function loadService(modelPaths: OcrWorkerJob['modelPaths']): Promise<PaddleOcrInstance> {
  if (cachedService === null) {
    cachedService = (async () => {
      const { PaddleOcrService } = await import('ppu-paddle-ocr')
      const service = new PaddleOcrService({
        model: {
          detection: modelPaths.detection,
          recognition: modelPaths.recognition,
          charactersDictionary: modelPaths.charactersDictionary
        },
        session: {}
      })
      await service.initialize()
      log('local OCR service initialized (cpu)')
      return service as unknown as PaddleOcrInstance
    })()
    cachedService.catch((error: unknown) => {
      // 初始化失败丢弃缓存 promise，让下一次请求重试（与原主进程语义一致）。
      cachedService = null
      log(`local OCR service init failed; will retry on next request: ${String((error as Error)?.message ?? error)}`)
    })
  }
  return cachedService
}

/** 识别一张图片（本机路径）。模型就绪性由主进程在派发前检查。 */
async function recognizeImage(imagePath: string, modelPaths: OcrWorkerJob['modelPaths']): Promise<string> {
  const task = queue.then(async () => {
    const service = await loadService(modelPaths)
    const buffer = await readFile(imagePath)
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const result = await service.recognize(bytes)
    return result.text
  })
  queue = task.catch(() => undefined)
  return task
}

/** sharp 预处理（灰度/对比拉伸/锐化）：扫描件质量参差，预处理显著影响识别率。 */
async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp(buffer).grayscale().normalize().sharpen().png({ quality: 100 }).toBuffer()
}

async function recognizePage(
  parser: PDFParse,
  pageNumber: number,
  scale: number,
  modelPaths: OcrWorkerJob['modelPaths']
): Promise<string> {
  const screenshot = await parser.getScreenshot({
    partial: [pageNumber],
    scale,
    imageBuffer: true,
    imageDataUrl: false
  })
  const rendered = screenshot.pages[0]?.data
  if (!rendered) {
    // 光栅化不出的页贡献空文本，不拖垮整本（与上游同语义）。
    return ''
  }
  const imagePath = path.join(os.tmpdir(), `rec-ocr-${process.pid}-${pageNumber}.png`)
  await writeFile(imagePath, await preprocessImage(Buffer.from(rendered)))
  try {
    const text = await recognizeImage(imagePath, modelPaths)
    return text.trim()
  } finally {
    await rm(imagePath, { force: true })
  }
}

async function run(job: OcrWorkerJob): Promise<void> {
  const { CanvasFactory } = await import('pdf-parse/worker')
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(job.pdfPath)), CanvasFactory })
  try {
    const totalPages = (await parser.getText()).total
    // 整本逐页（无页数预算：用户 2026-09-22 第二轮裁决，停止线全删）。
    let pagesDone = 0
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const pageText = await recognizePage(parser, pageNumber, job.scale, job.modelPaths)
      pagesDone = pageNumber
      post({ type: 'page', page: pageNumber, totalPages, text: pageText })
    }
    post({ type: 'done', pagesDone, totalPages })
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

parentPort?.on('message', (messageEvent) => {
  // 消息信封（真实 electron 宿主探针实证）：worker 侧 process.parentPort 的
  // 'message' 收到 MessageEvent、载荷在 .data；主进程侧 UtilityProcess 的
  // 'message' 才是直接值。scratch 垫片（child_process IPC）两侧都是直接值，
  // 曾掩盖过此差异。
  const job = (messageEvent as { data: unknown }).data as OcrWorkerJob
  void run(job).catch((error: unknown) => {
    post({ type: 'error', message: String((error as Error)?.message ?? error) })
  })
})
