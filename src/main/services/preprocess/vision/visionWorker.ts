/**
 * 视觉模型文档处理的光栅化 utility process 入口（v0.4.4）。
 *
 * 定位：文档处理通道 vision-model 条目的**本机光栅化腿**——pdf-parse 逐页
 * getScreenshot → PNG base64 回主进程，主进程把页图交给用户配置的视觉模型
 *（OpenAI 兼容多模态 chat）转写成 markdown。视觉模型 = 文档处理的子系统，
 * 本 worker 与 localOcrWorker 同属一个通道的两条执行腿，故同纪律：
 *
 * - **ping-pong 有界内存**：发一页 → 等一条 `{type:'next'}` 才继续下一页。
 *   主进程在该页的模型调用结束（成功或失败）后才放行，任意时刻只有一页图在内存里
 *   （整本预光栅化在几百页书上会把页图堆成 GB 级）。
 * - **为什么是 utilityProcess**：与 localOcrWorker 同因——pdf.js 逐页同步解析会打满
 *   承载进程的事件循环（§7.20「直读 PDF 卡窗口」的机制），且原生崩溃被隔离在子进程。
 * - **禁止 __dirname 依赖 / 禁 @logger**：日志一律经 postMessage 交主进程落盘
 *   （winston 双进程写同一文件会互锁）；本文件对 electron 的使用仅限
 *   `process.parentPort`（d.ts 的模块导出 parentPort 在 utility 宿主不存在）。
 * - 编译产物 out/main/visionWorker.js（electron.vite.config 多入口）。
 *
 * scale=2（144dpi）：视觉模型不需要 PP-OCR 的 3x/216dpi，页图体积直接决定网络
 * 往返与费用；612×792pt 页 → 1224×1584px，正文级字号清晰可读。
 */
import { readFile } from 'node:fs/promises'

interface VisionWorkerJob {
  pdfPath: string
  scale: number
}

type WorkerOutgoingMessage =
  | { type: 'log'; message: string }
  | { type: 'page'; page: number; totalPages: number; mediaType: 'image/png'; data: string }
  | { type: 'done'; totalPages: number }
  | { type: 'error'; message: string }

const parentPort = process.parentPort
const post = (message: WorkerOutgoingMessage): void => parentPort?.postMessage(message)
const log = (message: string): void => post({ type: 'log', message })

/** 放行闸：主进程消费完当前页（模型调用结束）后发 `{type:'next'}` 解开。 */
let releaseNext: (() => void) | null = null
const waitForNext = (): Promise<void> =>
  new Promise((resolve) => {
    releaseNext = resolve
  })

async function run(job: VisionWorkerJob): Promise<void> {
  const { CanvasFactory } = await import('pdf-parse/worker')
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(job.pdfPath)), CanvasFactory })
  try {
    const totalPages = (await parser.getText()).total
    for (let page = 1; page <= totalPages; page++) {
      const screenshot = await parser.getScreenshot({
        partial: [page],
        scale: job.scale,
        imageBuffer: true,
        imageDataUrl: false
      })
      const rendered = screenshot.pages[0]?.data
      // 光栅化不出的页回空图（主进程跳过该页，不拖垮整本）——与 localOcrWorker 同语义。
      post({
        type: 'page',
        page,
        totalPages,
        mediaType: 'image/png',
        data: rendered ? Buffer.from(rendered).toString('base64') : ''
      })
      await waitForNext()
    }
    post({ type: 'done', totalPages })
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

parentPort?.on('message', (messageEvent) => {
  // 消息信封（真实 electron 宿主探针实证）：worker 侧 process.parentPort 的
  // 'message' 收到 MessageEvent、载荷在 .data；主进程侧 UtilityProcess 的
  // 'message' 才是直接值。
  const payload = (messageEvent as { data: unknown }).data as VisionWorkerJob | { type: 'next' }
  if (typeof payload === 'object' && payload !== null && (payload as { type?: string }).type === 'next') {
    const release = releaseNext
    releaseNext = null
    release?.()
    return
  }
  const job = payload as VisionWorkerJob
  void run(job).catch((error: unknown) => {
    post({ type: 'error', message: String((error as Error)?.message ?? error) })
  })
})

log('vision document worker ready')
