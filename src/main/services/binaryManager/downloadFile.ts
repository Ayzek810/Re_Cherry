// fork 缝（原创，v0.4.5-1）：受管下载原语（唯一一件）。
//
// 为什么要有这件：旧实现（runtimeDownloader / sourceInstaller 各一份）把整包读进内存
// （`Buffer.from(await response.arrayBuffer())`）、用 `AbortSignal.timeout(120_000)` 卡
// **总时长**、失败即删 `.part`、没有任何字节进度。后果是真机上的三类失败：
// ① 均速低于 ~250 KB/s（2 Mbps）时 30MB 的运行时档案必然在 120s 被杀——慢而健康的下载
//    被当成故障，而且重试从零开始；
// ② 下载期间界面只有粗粒度步骤名，用户不知道是在下载、卡住还是死了；
// ③ 传输中断（企业网/代理抖动）没有源内重试，整个安装失败。
//
// 本件把这三件事一次做对：
// - **流式落盘**：读一块写一块（内存占用与档案大小无关）；
// - **空闲超时**：只有"连续 N 秒没有新数据"才算挂死，慢下载不受影响；总时长上限只作兜底
//   （防"一直有零星数据"的永不结束）；
// - **断点续传**：`.part` 保留，下一次尝试带 `Range` 续传；服务端不支持（200 而非 206）
//   就从头来；体积与 Content-Length 不符时按"多了=损坏删掉、少了=续传"处理；
// - **源内重试**：传输类/5xx/429 退避重试，4xx 立即失败（重试不会让它变成 200）；
// - **进度回调**：调用方据此把字节数摆到界面上（安装进度条的 detail）。
//
// 可测性：`fetchImpl` 与 `sink` 都是端口（main 测试环境 mock 了 node:fs），默认绑定见
// 文件末尾。

import fsp from 'node:fs/promises'

import { loggerService } from '@logger'

const logger = loggerService.withContext('DownloadFile')

/** 无数据到达的容忍上限（每收到一块重置）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000
/** 总时长兜底（只有"一直在漏数据但永不结束"才会撞上它）。 */
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000
/** 源内尝试次数（含首次）。 */
export const DEFAULT_MAX_ATTEMPTS = 3

export interface DownloadProgress {
  receivedBytes: number
  /** 已知总字节数（Content-Length；续传时为已收 + 剩余）。 */
  totalBytes?: number
}

/** 落盘端口（默认实现见 nodeDownloadSink）。 */
export interface DownloadSink {
  /** 目标文件当前字节数；不存在按 0。 */
  size(target: string): Promise<number>
  append(target: string, chunk: Uint8Array): Promise<void>
  remove(target: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface DownloadOptions {
  /** 人类可读标签——出现在失败消息的第一行（用户可见）。 */
  label: string
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  maxAttempts?: number
  headers?: Record<string, string>
  onProgress?: (progress: DownloadProgress) => void
  fetchImpl?: typeof fetch
  sink?: DownloadSink
}

export interface DownloadResult {
  path: string
  bytes: number
  /** 本次从已有 `.part` 续传的起始字节数（0 = 从头下载）。 */
  resumedFrom: number
}

// ---------------------------------------------------------------------------
// 进度上报的判定（纯函数：调用方持有 throttle 状态，逐次判定"值不值得报"）
// ---------------------------------------------------------------------------

/**
 * 进度上报节流器。进度回调是逐块触发的（30MB 档案 ≈ 数百次），而 IPC/渲染只需要一个会动
 * 的数字——不能逐块广播，也不能漏掉"完成"。
 */
export interface ProgressThrottle {
  lastReportedBytes: number
  lastFraction: number
  /** 是否已经上报过至少一次（首次必须报，否则进度条要等到 1MB 才从"不确定态"变成真条）。 */
  reported: boolean
}

export function createProgressThrottle(): ProgressThrottle {
  return { lastReportedBytes: 0, lastFraction: 0, reported: false }
}

export interface ProgressUpdate {
  /** 语言无关的人类可读文本（渲染层原样展示）。 */
  detail: string
  /** 确定性比例 0..1；总量未知时为 undefined（渲染层据此画"不确定态"）。 */
  fraction?: number
}

/** 字节进度 → 展示文本（总量未知时只给已收字节）。 */
export function formatDownloadProgress(progress: DownloadProgress): string {
  const received = (progress.receivedBytes / (1024 * 1024)).toFixed(1)
  const total = progress.totalBytes
  if (total === undefined || total <= 0) return `${received} MB`
  const percent = Math.min(100, Math.round((progress.receivedBytes / total) * 100))
  return `${percent}% · ${received}/${(total / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 判定一次进度回调是否要上报，并给出上报内容。
 *
 * 三条纪律（每条都对应真机上会看到的坏进度条）：
 * ① **首次必报 + 按 ~1MB 节流**：逐块广播会把 IPC 刷爆，但首次必须报——否则进度条要等到
 *    1MB 才从"不确定态"变成真条，字节数字也迟迟不出现；
 * ② **完成必报**：收满总量时无论间隔多小都报（否则进度条停在 97% 直到阶段结束）；
 * ③ **单调**：比例只增不减——服务端忽略 Range 从头下载、或将来某处又并行下载时，进度条
 *    倒退比不动更让人困惑。
 *
 * 就地更新 `throttle`，故调用方只需持有一个实例。
 */
export function selectProgressUpdate(
  throttle: ProgressThrottle,
  progress: DownloadProgress,
  minBytes = 1024 * 1024
): ProgressUpdate | undefined {
  const { receivedBytes, totalBytes } = progress
  const known = totalBytes !== undefined && totalBytes > 0
  const complete = known && receivedBytes >= totalBytes
  if (throttle.reported && !complete && receivedBytes - throttle.lastReportedBytes < minBytes) return undefined

  const fraction = known ? Math.min(1, receivedBytes / totalBytes) : undefined
  if (fraction !== undefined) {
    if (fraction < throttle.lastFraction) return undefined
    throttle.lastFraction = fraction
  }
  throttle.lastReportedBytes = receivedBytes
  throttle.reported = true
  return {
    detail: formatDownloadProgress(progress),
    ...(fraction !== undefined ? { fraction } : {})
  }
}

export const nodeDownloadSink: DownloadSink = {
  async size(target) {
    try {
      return (await fsp.stat(target)).size
    } catch {
      return 0
    }
  },
  async append(target, chunk) {
    await fsp.appendFile(target, chunk)
  },
  async remove(target) {
    await fsp.rm(target, { force: true })
  },
  async rename(from, to) {
    await fsp.rename(from, to)
  }
}

/** 4xx（除请求超时/限流/416）是确定性拒绝：重试不会让它变成 200，立即上抛。 */
function isTerminalStatus(status: number): boolean {
  // 416 = 已有 .part 比服务端资源还长（上次留下的坏档）——丢掉重来即可恢复，不是终态。
  if (status === 416) return false
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** 终态失败：重试没有意义（确定性拒绝），由 downloadFile 直接结束而不是退避重来。 */
class TerminalDownloadError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface AttemptOutcome {
  bytes: number
  resumedFrom: number
}

/**
 * 流式下载 `url` 到 `destPath`（先写 `<destPath>.part`，完成后改名）。
 *
 * 失败时**保留 `.part`**：下一次调用（或下一次安装）会带 `Range` 续传——这正是"慢网下
 * 反复重试永远从零开始"的解药。
 */
export async function downloadFile(url: string, destPath: string, options: DownloadOptions): Promise<DownloadResult> {
  const sink = options.sink ?? nodeDownloadSink
  const fetchImpl = options.fetchImpl ?? fetch
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const partPath = `${destPath}.part`
  const failures: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const outcome = await downloadAttempt({
        url,
        partPath,
        options,
        sink,
        fetchImpl,
        idleTimeoutMs,
        totalTimeoutMs
      })
      await sink.rename(partPath, destPath)
      options.onProgress?.({
        receivedBytes: outcome.bytes,
        ...(outcome.totalBytes !== undefined ? { totalBytes: outcome.totalBytes } : {})
      })
      return { path: destPath, bytes: outcome.bytes, resumedFrom: outcome.resumedFrom }
    } catch (error) {
      const message = errorMessage(error)
      failures.push(`attempt ${attempt}/${maxAttempts}: ${message}`)
      if (error instanceof TerminalDownloadError || attempt === maxAttempts) break
      // 保留 .part 让下一次尝试能续传；退避避免把抖动放大成风暴。
      logger.warn(`${options.label}: attempt ${attempt}/${maxAttempts} failed, retrying`, { error: message })
      await delay(500 * attempt)
    }
  }
  const attempts = failures.length > 1 ? ` after ${failures.length} attempts` : ''
  throw new Error(`${options.label} failed${attempts}:\n${failures.join('\n')}`)
}

interface AttemptContext {
  url: string
  partPath: string
  options: DownloadOptions
  sink: DownloadSink
  fetchImpl: typeof fetch
  idleTimeoutMs: number
  totalTimeoutMs: number
}

async function downloadAttempt(context: AttemptContext): Promise<AttemptOutcome & { totalBytes?: number }> {
  const { url, partPath, options, sink, fetchImpl, idleTimeoutMs, totalTimeoutMs } = context
  let resumedFrom = await sink.size(partPath)
  const controller = new AbortController()
  let expiry: 'idle' | 'total' | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let totalTimer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      expiry = 'idle'
      controller.abort()
    }, idleTimeoutMs)
  }
  totalTimer = setTimeout(() => {
    expiry = 'total'
    controller.abort()
  }, totalTimeoutMs)
  armIdleTimer()

  try {
    const headers: Record<string, string> = { ...options.headers }
    if (resumedFrom > 0) headers.Range = `bytes=${resumedFrom}-`
    const response = await fetchImpl(url, { headers, signal: controller.signal })

    if (isTerminalStatus(response.status)) {
      throw new TerminalDownloadError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
    }
    if (!response.ok || response.status === 416) {
      // 416 = 已有的 .part 比服务端资源还长（通常是上次留下的坏档）→ 丢掉重来。
      if (response.status === 416) {
        await sink.remove(partPath)
        resumedFrom = 0
      }
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
    }
    if (resumedFrom > 0 && response.status !== 206) {
      // 服务端忽略了 Range：从头来，别把两段数据拼在一起。
      logger.info(`${options.label}: server ignored the Range request; restarting from zero`)
      await sink.remove(partPath)
      resumedFrom = 0
    }

    const contentLength = Number(response.headers.get('content-length') ?? '')
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? resumedFrom + contentLength : undefined
    options.onProgress?.({ receivedBytes: resumedFrom, ...(totalBytes !== undefined ? { totalBytes } : {}) })

    const body = response.body
    if (!body) throw new Error('the response carried no body')
    const reader = body.getReader()
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      armIdleTimer()
      await sink.append(partPath, value)
      received += value.byteLength
      options.onProgress?.({
        receivedBytes: resumedFrom + received,
        ...(totalBytes !== undefined ? { totalBytes } : {})
      })
    }

    const bytes = resumedFrom + received
    if (totalBytes !== undefined && bytes !== totalBytes) {
      if (bytes > totalBytes) {
        // 比声明的还长：内容已经不可信，丢掉让下次从头来。
        await sink.remove(partPath)
        throw new Error(`size mismatch: expected ${totalBytes} bytes, received ${bytes} (discarded the partial file)`)
      }
      // 少了：留着续传（连接被对端掐断是最常见的原因）。
      throw new Error(`incomplete download: ${bytes}/${totalBytes} bytes`)
    }
    return { bytes, resumedFrom, ...(totalBytes !== undefined ? { totalBytes } : {}) }
  } catch (error) {
    if (expiry === 'idle') {
      throw new Error(`no data received for ${Math.round(idleTimeoutMs / 1000)}s (stalled)`)
    }
    if (expiry === 'total') {
      throw new Error(`exceeded the ${Math.round(totalTimeoutMs / 60_000)} minute ceiling`)
    }
    throw error instanceof Error ? error : new Error(errorMessage(error))
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (totalTimer) clearTimeout(totalTimer)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 多源下载（主源失败即换下一个源，源内各自走 {@link downloadFile} 的续传与重试）。
 * 用于运行时档案与源码归档：node/python 走 npmmirror → 官方，源码走加速前缀 → codeload。
 */
export async function downloadFromAnySource(
  urls: readonly string[],
  destPath: string,
  options: DownloadOptions
): Promise<DownloadResult> {
  const failures: string[] = []
  for (const url of urls) {
    try {
      return await downloadFile(url, destPath, options)
    } catch (error) {
      const message = errorMessage(error)
      failures.push(`${url} -> ${message}`)
      // ASCII 箭头：→ 会被 GBK 控制台啃成乱码（真机日志取证）。
      logger.warn(`${options.label}: source failed, falling back to the next one`, { url, error: message })
      // 换源意味着资源可能不同，上一个源的半成品不能拿来续传。
      await (options.sink ?? nodeDownloadSink).remove(`${destPath}.part`)
    }
  }
  throw new Error(`${options.label} failed from every source:\n${failures.join('\n')}`)
}
