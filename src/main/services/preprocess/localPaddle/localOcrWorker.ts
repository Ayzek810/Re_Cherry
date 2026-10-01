/**
 * LocalPaddle OCR utility process 入口（v0.3.2 性能事故修复，2026-09-22；
 * v0.4.4 自 services/localModel/ocrWorker.ts 收编；v0.4.4-1 常驻化 + 页级并发）。
 *
 * 事故背景：一切 PDF → OCR 的路由下，1436 页 PDF 在主进程逐页推理 ≈ 数小时，
 * 主线程被独占 → 窗口整体冻结（真机实锤）。
 *
 * 本进程承接全套重活：pdf-parse 逐页光栅化 → sharp 预处理 → ppu-paddle-ocr 推理。
 * 主进程（localOcr.ts）只做编排——OCR 结果一字不变。
 *
 * **v0.4.4-1 常驻 + 并发（用户裁定）**：
 * - **常驻**：本进程由主进程跨解析复用（热模型跨本保留，省 ~15s/本的权重冷加载）；
 *   5 分钟无消息自退（exit 0），主进程对空闲退出静默接管、下次解析重 fork。
 * - **页级并发**：信用窗（job.window = 并发数，发一页扣一信、主进程结算一页回一信
 *   {type:'next'}）；页任务（光栅化/sharp/识别）并发执行，在途页图 ≤ window。
 *   识别侧并发安全：ORT `session.run` 线程安全（同会话并发 run 合法）。
 * - **取消**：{type:'cancel'} 按代号停止页循环（在途 ONNX 推理不可中断，当前页
 *   跑完即停），进程不退出——热模型留给下一次解析。
 *
 * **为什么是 utilityProcess 而不是 worker_threads**：本机实测 worker_threads
 * 里加载 onnxruntime/sharp 原生模块 → 整进程 0xC0000005（机器级事实）；
 * utilityProcess 原生崩溃被隔离，正是"崩溃隔离"的落地形态。
 *
 * **parentPort 的获取途径（2026-09-22 真机实锤，判据级）**：utility 宿主里
 * d.ts 的模块导出 parentPort 不存在（类型撒谎），正解是 `process.parentPort`。
 *
 * 纪律（违反即事故）：本文件对 electron 的使用**仅限 process.parentPort**；
 * 禁止 @logger（winston 双进程写同一日志文件会互锁），日志一律经 postMessage
 * 交主进程落盘；模型路径由主进程经消息传入。编译产物 out/main/localOcrWorker.js。
 *
 * 安装版运行时依赖（v0.4.4 实证）：sharp / ppu-paddle-ocr / ppu-ocv /
 * onnxruntime-node 必须进包且原生件解包——electron-builder.yml asarUnpack +
 * optionalDependencies + scripts/after-pack.js 断言守门。
 */
import { readFile } from 'node:fs/promises'

/** 主进程下发的任务（全部数据不可从子进程侧自取）。 */
interface OcrWorkerJob {
  type: 'job'
  pdfPath: string
  scale: number
  /** 信用窗初始额度（= 主进程页级并发数）。 */
  window: number
  /** GPU 加速（DirectML/CoreML；false = 仅 CPU）。 */
  gpu: boolean
  modelPaths: { detection: string; recognition: string; charactersDictionary: string }
}

type WorkerIncoming = OcrWorkerJob | { type: 'cancel' } | { type: 'next' }

interface PaddleOcrInstance {
  initialize(): Promise<void>
  recognize(image: ArrayBuffer): Promise<{ text: string; lines?: unknown }>
  destroy(): Promise<void>
}

type WorkerMessage =
  | { type: 'log'; message: string }
  | { type: 'page'; page: number; totalPages: number; text: string }
  | { type: 'done'; pagesDone: number; totalPages: number }
  | { type: 'cancelled'; pagesDone: number }
  | { type: 'error'; message: string }

const parentPort = process.parentPort
const post = (message: WorkerMessage): void => parentPort?.postMessage(message)
const log = (message: string): void => post({ type: 'log', message })

/** ppu-paddle-ocr 的结构化最小面（类类型导出形态不在 fork 控制内，按用法收窄）。 */
let cachedService: Promise<PaddleOcrInstance> | null = null
/** 缓存会话的 GPU 开关态：面板切换后与缓存不一致 → 释放旧会话按新 EP 重建。 */
let cachedGpu: boolean | null = null

function loadService(modelPaths: OcrWorkerJob['modelPaths'], gpuEnabled: boolean): Promise<PaddleOcrInstance> {
  if (cachedService !== null && cachedGpu !== gpuEnabled) {
    const stale = cachedService
    cachedService = null
    void stale.then((service) => service.destroy().catch(() => undefined)).catch(() => undefined)
    log(`GPU acceleration toggled to ${String(gpuEnabled)}; rebuilding OCR session`)
  }
  if (cachedService === null) {
    cachedGpu = gpuEnabled
    cachedService = (async () => {
      const { PaddleOcrService } = await import('ppu-paddle-ocr')
      const service = new PaddleOcrService({
        model: {
          detection: modelPaths.detection,
          recognition: modelPaths.recognition,
          charactersDictionary: modelPaths.charactersDictionary
        },
        session: gpuSessionOptions(gpuEnabled)
      })
      await service.initialize()
      log('local OCR service initialized')
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

/**
 * GPU 加速（v0.4.4-1 研究结论，真模型实测）：DirectML 上 det 25×/rec 8× 于 CPU
 * （det 1078→42ms、rec 82→10ms），DirectML.dll 随 onnxruntime-node 自带且已被
 * asarUnpack 解包到位；ppu 补丁版 createSessionWithFallback 在 DML 创建失败
 * （无 DX12 GPU / 驱动问题）时**自动落回 CPU** 并触发 onSessionFallback（此处
 * 转日志）。平台门控：win32 → dml；darwin → coreml；其余无自带 GPU EP → cpu。
 * gpu=false（面板开关关闭）→ 仅 CPU。
 */
function gpuSessionOptions(gpuEnabled: boolean): {
  executionProviders: string[]
  onSessionFallback: (error: unknown) => void
} {
  const gpu: string[] =
    gpuEnabled === false ? [] : process.platform === 'win32' ? ['dml'] : process.platform === 'darwin' ? ['coreml'] : []
  return {
    executionProviders: [...gpu, 'cpu'],
    onSessionFallback: (error: unknown) => {
      log(`GPU execution provider failed (${String((error as Error)?.message ?? error)}); fell back to CPU`)
    }
  }
}

/** 识别一张图（ArrayBuffer 直入，不经临时文件）。并发安全：ORT session.run 线程安全。 */
async function recognizeImage(
  imageBytes: ArrayBuffer,
  modelPaths: OcrWorkerJob['modelPaths'],
  gpuEnabled: boolean
): Promise<string> {
  const service = await loadService(modelPaths, gpuEnabled)
  const result = await service.recognize(imageBytes)
  return result.text
}

/** sharp 预处理（灰度/对比拉伸/锐化）：扫描件质量参差，预处理显著影响识别率。 */
async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp(buffer).grayscale().normalize().sharpen().png({ quality: 100 }).toBuffer()
}

/** 信用窗：发一页扣一信，主进程结算一页（{type:'next'}）回一信。 */
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

/** 当前 run 的取消态：cancel 只作用于在跑的这代（编排层串行队列保证同一时刻至多一个 run）。 */
let cancelled = false

async function run(job: OcrWorkerJob): Promise<void> {
  const { CanvasFactory } = await import('pdf-parse/worker')
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(job.pdfPath)), CanvasFactory })
  const inflight = new Set<Promise<void>>()
  let pagesDone = 0
  try {
    // 页数走 getInfo（零提取）——getText 会把整本文本层白白提取一遍。
    credits = Math.max(1, Math.floor(job.window))
    const { total } = await parser.getInfo()
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      if (cancelled) break
      await acquireCredit()
      if (cancelled) break
      const task = (async () => {
        const screenshot = await parser.getScreenshot({
          partial: [pageNumber],
          scale: job.scale,
          imageBuffer: true,
          imageDataUrl: false
        })
        const rendered = screenshot.pages[0]?.data
        let text = ''
        if (rendered) {
          // ArrayBuffer 直入识别（不落临时文件）；单页失败照旧上抛 → 废整本（用户裁定）。
          const pre = await preprocessImage(Buffer.from(rendered))
          const bytes = pre.buffer.slice(pre.byteOffset, pre.byteOffset + pre.byteLength) as ArrayBuffer
          text = (await recognizeImage(bytes, job.modelPaths, job.gpu)).trim()
        }
        if (cancelled) return
        pagesDone = Math.max(pagesDone, pageNumber)
        post({ type: 'page', page: pageNumber, totalPages: total, text })
      })()
      inflight.add(task)
      void task.catch(() => undefined).finally(() => inflight.delete(task))
    }
    await Promise.allSettled([...inflight])
    if (cancelled) {
      post({ type: 'cancelled', pagesDone })
    } else {
      post({ type: 'done', pagesDone, totalPages: total })
    }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

/** 空闲自退：任何消息重置计时；5 分钟无消息 exit(0)——主进程静默接管。 */
const IDLE_EXIT_MS = 5 * 60 * 1000
let idleTimer: NodeJS.Timeout | null = null
function armIdleExit(): void {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    log('local OCR worker idle exit')
    process.exit(0)
  }, IDLE_EXIT_MS)
}
armIdleExit()

parentPort?.on('message', (messageEvent) => {
  armIdleExit()
  // 消息信封（真实 electron 宿主探针实证）：worker 侧 process.parentPort 的
  // 'message' 收到 MessageEvent、载荷在 .data；主进程侧 UtilityProcess 的
  // 'message' 才是直接值。
  const payload = (messageEvent as { data: unknown }).data as WorkerIncoming
  if (typeof payload !== 'object' || payload === null) return
  if (payload.type === 'next') {
    credits += 1
    waiter?.()
    return
  }
  if (payload.type === 'cancel') {
    cancelled = true
    return
  }
  // 新任务：重置取消态（编排层串行队列保证上一代已收口）。
  cancelled = false
  const job = payload
  void run(job).catch((error: unknown) => {
    post({ type: 'error', message: String((error as Error)?.message ?? error) })
  })
})
