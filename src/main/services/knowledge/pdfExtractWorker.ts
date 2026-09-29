/**
 * PDF 文本层抽取 utility process 入口（v0.4.4-2，§7.20 挂账清偿）：
 * pdf-parse 的 getText 在主进程逐页解析会打满事件循环（§7.20「直读 PDF 卡窗口」
 * 实锤）——本进程承接 PDF 文本层抽取，主进程事件循环不再被 pdf.js 占用。
 *
 * 协议：{type:'extract', id, filePath} → {type:'result', id, text}（或 error）。
 * id 由主进程分配（常驻 worker 跨请求复用，按 id 关联请求与结果）。
 * 串行处理（同一时刻一个抽取任务——编排层解析队列已串行化）。
 *
 * 纪律（与 localOcrWorker 同款，违反即事故）：electron 的使用仅限
 * process.parentPort；禁止 @logger（winston 双进程写同一日志文件互锁），日志经
 * postMessage 交主进程落盘；5 分钟无消息自退（exit 0，主进程静默接管）。
 * 编译产物 out/main/pdfExtractWorker.js（electron.vite.config 多入口）。
 */
import { readFile } from 'node:fs/promises'

type WorkerIncoming = { type: 'extract'; id: number; filePath: string }

type WorkerMessage =
  | { type: 'log'; message: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

const parentPort = process.parentPort
const post = (message: WorkerMessage): void => parentPort?.postMessage(message)
const log = (message: string): void => post({ type: 'log', message })

async function extract(id: number, filePath: string): Promise<void> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(await readFile(filePath)) })
  try {
    const result = await parser.getText()
    post({ type: 'result', id, text: result.text ?? '' })
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
    log('pdf extract worker idle exit')
    process.exit(0)
  }, IDLE_EXIT_MS)
}
armIdleExit()

parentPort?.on('message', (messageEvent) => {
  armIdleExit()
  // 消息信封（真实 electron 宿主探针实证）：worker 侧收到 MessageEvent、载荷在 .data。
  const payload = (messageEvent as { data: unknown }).data as WorkerIncoming
  if (typeof payload !== 'object' || payload === null || payload.type !== 'extract') return
  void extract(payload.id, payload.filePath).catch((error: unknown) => {
    post({ type: 'error', id: payload.id, message: String((error as Error)?.message ?? error) })
  })
})
