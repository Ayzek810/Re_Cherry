/**
 * 视觉模型文档处理的光栅化 utility process 入口。
 *
 * 定位：文档处理通道 vision-model 条目的**本机光栅化腿**——pdf-parse 逐页
 * getScreenshot（PNG）→ 转 JPEG q80 → base64 回主进程，主进程把页图交给用户配置的视觉模型
 *（OpenAI 兼容多模态 chat）转写成 markdown。视觉模型 = 文档处理的子系统，
 * 本 worker 与 localOcrWorker 同属一个通道的两条执行腿，故同纪律：
 *
 * - **ping-pong 有界内存**：发一页 → 等一条 `{type:'next'}` 才继续下一页。
 *   主进程在该页的模型调用结束（成功或失败）后才放行，任意时刻只有一页图在内存里
 *   （整本预光栅化在几百页书上会把页图堆成 GB 级）。
 * - **为什么是 utilityProcess**：与 localOcrWorker 同因——pdf.js 逐页同步解析会打满
 * 承载进程的事件循环（「直读 PDF 卡窗口」的机制），且原生崩溃被隔离在子进程。
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
  /**
   * 信用窗初始额度（= 主进程的页级并发数）：发一页扣一信，主进程结算完一页回一信
   * （{type:'next'}）——在途页图恒 ≤ window，几百页书不会把页图堆成 GB 级。
   */
  window: number
}

type WorkerOutgoingMessage =
  | { type: 'log'; message: string }
  | { type: 'page'; page: number; totalPages: number; mediaType: 'image/png' | 'image/jpeg'; data: string }
  | { type: 'done'; totalPages: number }
  | { type: 'error'; message: string }

/** 页图 JPEG 质量（v1）：实测同一页 q80 已经把 1521KB 压到 286KB，再高只增体积不增可读性。 */
const PAGE_JPEG_QUALITY = 80

const parentPort = process.parentPort
const post = (message: WorkerOutgoingMessage): void => parentPort?.postMessage(message)
const log = (message: string): void => post({ type: 'log', message })

/** 信用窗：发一页扣一信（acquire），主进程结算一页回一信（{type:'next'}）。 */
let credits = 0
let waiter: (() => void) | null = null
const acquireCredit = (): Promise<void> => {
  if (credits > 0) {
    credits -= 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiter = () => {
      credits -= 1
      waiter = null
      resolve()
    }
  })
}

async function run(job: VisionWorkerJob): Promise<void> {
  const { CanvasFactory } = await import('pdf-parse/worker')
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(job.pdfPath)), CanvasFactory })
  try {
    // 页数走 getInfo（零提取，只开文档树）——getText 会把整本文本层白白提取一遍。
    credits = Math.max(1, Math.floor(job.window))
    const { total } = await parser.getInfo()
    for (let page = 1; page <= total; page++) {
      await acquireCredit()
      const screenshot = await parser.getScreenshot({
        partial: [page],
        scale: job.scale,
        imageBuffer: true,
        imageDataUrl: false
      })
      const rendered = screenshot.pages[0]?.data
      // 光栅化不出的页回空图（主进程跳过该页，不拖垮整本）——与 localOcrWorker 同语义。
      const encoded =
        rendered === undefined || rendered.byteLength === 0
          ? { mediaType: 'image/png' as const, bytes: Buffer.alloc(0) }
          : await encodePage(Buffer.from(rendered), page)
      post({
        type: 'page',
        page,
        totalPages: total,
        mediaType: encoded.mediaType,
        data: encoded.bytes.toString('base64')
      })
    }
    post({ type: 'done', totalPages: total })
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

/**
 * 页图编码：getScreenshot 只出 PNG，转成 JPEG 再上行（v1）。
 *
 * 依据（2026-10-01 实机量取，20 页扫描书第 1 页）：PNG 1521KB → JPEG q80 286KB，省 81%，
 * 编码 39ms。页图是照片性质的内容，无损 PNG 只把上传时长、对端排队与失败率一起抬高
 * （同一本书 PNG 请求 120s 被对端掐断，见 lightLlmModalities 的 VISION_REQUEST_TIMEOUT_MS）。
 * 编码器缺失/失败时如实退回 PNG（页图仍可用，只是更大）并留一行日志，不静默降级成空页。
 */
async function encodePage(
  png: Buffer,
  page: number
): Promise<{ mediaType: 'image/png' | 'image/jpeg'; bytes: Buffer }> {
  try {
    const sharp = (await import('sharp')).default
    const jpeg = await sharp(png).jpeg({ quality: PAGE_JPEG_QUALITY }).toBuffer()
    return { mediaType: 'image/jpeg', bytes: jpeg }
  } catch (error) {
    log(`page ${page}: JPEG encode failed (${String((error as Error)?.message ?? error)}); sending PNG`)
    return { mediaType: 'image/png', bytes: png }
  }
}

parentPort?.on('message', (messageEvent) => {
  // 消息信封（真实 electron 宿主探针实证）：worker 侧 process.parentPort 的
  // 'message' 收到 MessageEvent、载荷在 .data；主进程侧 UtilityProcess 的
  // 'message' 才是直接值。
  const payload = (messageEvent as { data: unknown }).data as VisionWorkerJob | { type: 'next' }
  if (typeof payload === 'object' && payload !== null && (payload as { type?: string }).type === 'next') {
    credits += 1
    waiter?.()
    return
  }
  const job = payload as VisionWorkerJob
  void run(job).catch((error: unknown) => {
    post({ type: 'error', message: String((error as Error)?.message ?? error) })
  })
})

log('vision document worker ready')
