/**
 * 文档处理通道执行缝（2026-09-22 用户第三轮裁决：ocr_document 挂进文档处理通道）。
 *
 * 用户原话钉死两条语义：①"我让你把这个也挂进文档处理通道是干什么的"——工具按
 * 用户在 设置 → 文档处理 配置的服务商路由，LocalPaddle 只是通道里的本地条目，
 * 不是通道本体（曾把工具绑死 LocalPaddle 被否决返工）；②"5 分钟上限我没反对
 * （只是您可以再放宽到 8 分钟，大书云解析也要点时间）"——被删的是文本截断上限
 * （200k，终局删除），时间预算保留并放宽到 8 分钟。知识库摄取路径显式传
 * Infinity（后台 FIFO 无预算，§7.16 裁决 ③ 未被撤回）。
 *
 * 云端五家（MinerU / Doc2x / Mistral / Open MinerU / PaddleOCR）自上游
 * cherry-studio v1.9.11 knowledge/preprocess 同名适配器移植：载体从
 * FileMetadata/FileStorage 链重塑为 (pdfPath → markdown 文本)——聊天工具与
 * 向量摄取都只要文本，不需要上游的产物文件落盘/改名/回填元数据三段舞。
 * zip 解包用 fork 已有 node-stream-zip（BackupManager 同款），multipart 用
 * Node 全局 FormData/Blob，零新依赖。
 *
 * 配置表：渲染层 preprocess 切片整体推送（Dsh_SyncPreprocess，webSearch 同构，
 * apiKey 只进主进程内存，不落盘不进会话）；每轮走哪个服务商由 topics.sendMessage
 * 登记（渲染层上行本轮默认服务商 id），工具执行时按 topicId 反查。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { ocrPdfFile } from '@main/services/localModel/pdfOcr'
import { net } from 'electron'
import StreamZip from 'node-stream-zip'

const logger = loggerService.withContext('PreprocessChannel')

const MB = 1024 * 1024

/** 工具路径默认时间预算（用户裁决：8 分钟）。 */
export const TOOL_OCR_TIME_BUDGET_MS = 8 * 60 * 1000

/** 文档处理服务商配置（preprocess 切片 provider 的主进程投影）。 */
export interface PreprocessProviderConfig {
  id: string
  apiKey?: string
  apiHost?: string
  model?: string
}

export interface ParsePdfOptions {
  /** 整体时间预算毫秒；缺省 8 分钟，知识库摄取路径传 Number.POSITIVE_INFINITY。 */
  budgetMs?: number
}

// ---------------------------------------------------------------------------
// 服务商配置表（同步投影 + 每轮登记）
// ---------------------------------------------------------------------------

class PreprocessChannelRegistry {
  private readonly providers = new Map<string, PreprocessProviderConfig>()
  private readonly turnProviders = new Map<string, string | undefined>()

  /** 渲染层 preprocess 切片整体投影（启动与切片变更时各推一次；整体替换）。 */
  setConfig(providers: PreprocessProviderConfig[]): void {
    this.providers.clear()
    for (const provider of providers) {
      this.providers.set(provider.id, provider)
    }
  }

  getConfig(id: string): PreprocessProviderConfig | undefined {
    return this.providers.get(id)
  }

  /**
   * 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用文档阅读，
   * ocr_document 此时不该被调，执行侧防线拒答）。即设即覆盖，无清理需求。
   */
  setTurnProvider(topicId: string, providerId: string | undefined): void {
    if (providerId === undefined) {
      this.turnProviders.delete(topicId)
    } else {
      this.turnProviders.set(topicId, providerId)
    }
  }

  getTurnProviderId(topicId: string): string | undefined {
    return this.turnProviders.get(topicId)
  }
}

export const preprocessChannel = new PreprocessChannelRegistry()

/** 服务商是否已配置到可执行（挂载门用；local-paddle 的模型检查在执行时如实报错）。 */
export function isProviderConfigured(config: PreprocessProviderConfig): boolean {
  switch (config.id) {
    case 'local-paddle':
      return true
    case 'mineru':
    case 'doc2x':
    case 'mistral':
      return typeof config.apiKey === 'string' && config.apiKey.length > 0
    case 'open-mineru':
      return typeof config.apiHost === 'string' && config.apiHost.length > 0
    case 'paddleocr':
      return (config.apiKey?.length ?? 0) > 0 && (config.apiHost?.length ?? 0) > 0
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// 统一入口：按服务商 id 路由 + 时间预算
// ---------------------------------------------------------------------------

/**
 * 整本 PDF 走指定服务商解析。时间预算（缺省 8 分钟）对本路由生效：超时经
 * AbortController 打断在途请求/轮询/本地 OCR 子进程（kill），拒绝并给可行动错误。
 */
export async function parsePdfWithProvider(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal,
  options?: ParsePdfOptions
): Promise<string> {
  const budgetMs = options?.budgetMs ?? TOOL_OCR_TIME_BUDGET_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuterAbort: (() => void) | undefined
  if (Number.isFinite(budgetMs)) {
    const minutes = Math.max(1, Math.round(budgetMs / 60000))
    timer = setTimeout(() => {
      controller.abort(
        new Error(
          `OCR time budget (${minutes} min) exceeded — the document is too large for provider ` +
            `"${config.id}"; split the PDF or switch provider in 设置 → 文档处理`
        )
      )
    }, budgetMs)
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      onOuterAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }
  }
  try {
    switch (config.id) {
      case 'local-paddle':
        return await ocrPdfFile(filePath, controller.signal)
      case 'mineru':
        return await parseWithMineru(config, filePath, controller.signal)
      case 'doc2x':
        return await parseWithDoc2x(config, filePath, controller.signal)
      case 'mistral':
        return await parseWithMistral(config, filePath, controller.signal)
      case 'open-mineru':
        return await parseWithOpenMineru(config, filePath, controller.signal)
      case 'paddleocr':
        return await parseWithPaddleOcr(config, filePath, controller.signal)
      default:
        throw new Error(
          `unknown document-processing provider "${config.id}" (supported: mineru, doc2x, mistral, open-mineru, paddleocr, local-paddle)`
        )
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onOuterAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
  }
}

// ---------------------------------------------------------------------------
// 共享小件
// ---------------------------------------------------------------------------

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 服务商明确失败（终态）：pollUntil 不重试，立即上抛。 */
export class TerminalPollError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function normalizeHost(apiHost: string | undefined, fallback: string | undefined): string | undefined {
  const host = apiHost?.trim() || fallback
  return host === undefined ? undefined : host.replace(/\/+$/, '')
}

function requireKey(config: PreprocessProviderConfig, name: string): string {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new Error(`${name} API key is not configured (设置 → 文档处理)`)
  }
  return config.apiKey
}

async function requireOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${response.statusText}`)
  }
  return response
}

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown
}

/** 服务商上限校验（上游同款：上传前快速失败，避免整本白传）。 */
async function assertPdfLimits(filePath: string, limits: { maxBytesMb?: number; maxPages?: number }): Promise<void> {
  if (limits.maxBytesMb !== undefined) {
    const stat = await fsp.stat(filePath)
    if (stat.size >= limits.maxBytesMb * MB) {
      throw new Error(
        `PDF file size (${Math.round(stat.size / MB)}MB) exceeds the ${limits.maxBytesMb}MB limit of the provider`
      )
    }
  }
  if (limits.maxPages !== undefined) {
    try {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: new Uint8Array(await fsp.readFile(filePath)) })
      try {
        const total = (await parser.getText()).total
        if (total > limits.maxPages) {
          throw new Error(`PDF page count (${total}) exceeds the ${limits.maxPages}-page limit of the provider`)
        }
      } finally {
        await parser.destroy().catch(() => undefined)
      }
    } catch (error) {
      // 页数上限错误照常上抛；结构解析失败则跳过页数校验继续交给服务商（上游同语义）。
      if (error instanceof Error && error.message.includes('limit of the provider')) throw error
      logger.warn('PDF structure unreadable; skipping page-count validation', toError(error))
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new Error('aborted'))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 轮询直至 attempt 返回非 undefined（done）。attempt 抛 TerminalPollError =
 * 服务商明确失败，立即上抛不重试；其他抛错按抖动重试（上游同语义），次数
 * 耗尽上抛最后一次；abort 随 sleep/throwIfAborted 即时打断。
 */
async function pollUntil<T>(o: {
  label: string
  attempts: number
  intervalMs: number
  signal?: AbortSignal
  attempt: () => Promise<T | undefined>
}): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    o.signal?.throwIfAborted()
    try {
      const done = await o.attempt()
      if (done !== undefined) return done
    } catch (error) {
      if (error instanceof TerminalPollError) throw error
      lastError = error
      logger.warn(`${o.label} poll attempt ${attempt}/${o.attempts} failed, retrying`, toError(error))
    }
    await sleep(o.intervalMs, o.signal)
  }
  throw lastError ?? new Error(`${o.label} polling exhausted after ${o.attempts} attempts`)
}

async function downloadBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await requireOk(await net.fetch(url, { method: 'GET', signal }), 'result download')
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * 结果 zip → 取 .md 文本（MinerU/Doc2x 的产物都是一个装着 markdown 的 zip）。
 * 不解包落盘：node-stream-zip 直读条目；多个 .md 时取目录层级最浅的（MinerU 新版
 * 会多套一层 {name}/{parse_method}/ 目录，上游同名处理）。
 */
async function markdownFromZip(zipBytes: Uint8Array, label: string): Promise<string> {
  const zipPath = path.join(
    os.tmpdir(),
    `re-cherry-preprocess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`
  )
  await fsp.writeFile(zipPath, zipBytes)
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries = await zip.entries()
    const mdEntries = Object.values(entries)
      .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length)
    if (mdEntries.length === 0) {
      throw new Error(`${label} result zip contains no markdown file`)
    }
    const data = await zip.entryData(mdEntries[0].name)
    const markdown = Buffer.from(data).toString('utf8').trim()
    if (markdown.length === 0) {
      throw new Error(`${label} result markdown is empty`)
    }
    return markdown
  } finally {
    await zip.close().catch(() => undefined)
    await fsp.rm(zipPath, { force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 云端五家（上游 cherry-studio v1.9.11 knowledge/preprocess 移植）
// ---------------------------------------------------------------------------

/** MinerU 官方 API：申请批量直传 URL → PUT 上传 → 轮询批量解析状态 → 下载 zip。 */
async function parseWithMineru(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = requireKey(config, 'MinerU')
  const apiHost = normalizeHost(config.apiHost, 'https://mineru.net') as string
  await assertPdfLimits(filePath, { maxBytesMb: 200, maxPages: 600 })
  const fileName = path.basename(filePath)

  const created = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/api/v4/file-urls/batch`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: '*/*' },
          body: JSON.stringify({
            language: 'auto',
            enable_formula: true,
            enable_table: true,
            files: [{ name: fileName, is_ocr: true, data_id: fileName }]
          })
        }),
        'MinerU batch upload URL request'
      )
    )
  )
  if (Number(created?.code) !== 0) {
    throw new Error(`MinerU API error: ${str(created?.msg) ?? 'unknown error'}`)
  }
  const createdData = asRecord(created?.data)
  const batchId = str(createdData?.batch_id)
  const fileUrls = arr(createdData?.file_urls)
  if (batchId === undefined || fileUrls === undefined || fileUrls.length === 0 || typeof fileUrls[0] !== 'string') {
    throw new Error('MinerU response missing batch_id/file_urls')
  }
  const uploadHeaders = asRecord(arr(createdData?.headers)?.[0])
  const headerRecord: Record<string, string> = {}
  for (const [key, value] of Object.entries(uploadHeaders ?? {})) {
    if (typeof value === 'string') headerRecord[key] = value
  }

  await requireOk(
    await net.fetch(fileUrls[0], {
      method: 'PUT',
      signal,
      headers: headerRecord,
      body: new Uint8Array(await fsp.readFile(filePath))
    }),
    'MinerU file upload'
  )

  const zipUrl = await pollUntil({
    label: 'MinerU',
    attempts: 60,
    intervalMs: 5000,
    signal,
    attempt: async () => {
      const response = asRecord(
        await readJson(
          await requireOk(
            await net.fetch(`${apiHost}/api/v4/extract-results/batch/${batchId}`, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal
            }),
            'MinerU status poll'
          )
        )
      )
      if (Number(response?.code) !== 0) {
        throw new Error(`MinerU API error: ${str(response?.msg) ?? 'unknown error'}`)
      }
      const results = arr(asRecord(response?.data)?.extract_result) ?? []
      const mine = results.map(asRecord).find((entry) => entry?.file_name === fileName) ?? results.map(asRecord)[0]
      const state = str(mine?.state)
      if (state === 'failed') {
        throw new TerminalPollError(`MinerU parsing failed: ${str(mine?.err_msg) ?? 'unknown error'}`)
      }
      if (state === 'done') {
        return str(mine?.full_zip_url)
      }
      return undefined
    }
  })
  return markdownFromZip(await downloadBytes(zipUrl, signal), 'MinerU')
}

/** Doc2x v2 API：preupload → PUT → 轮询解析状态 → 触发 md 导出 → 轮询导出 → 下载 zip。 */
async function parseWithDoc2x(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = requireKey(config, 'Doc2x')
  const apiHost = normalizeHost(config.apiHost, 'https://v2.doc2x.noedgeai.com') as string
  await assertPdfLimits(filePath, { maxBytesMb: 300, maxPages: 1000 })
  const authHeaders = { Authorization: `Bearer ${apiKey}` }

  const pre = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/api/v2/parse/preupload`, { method: 'POST', signal, headers: authHeaders }),
        'Doc2x preupload'
      )
    )
  )
  if (str(pre?.code) !== 'success') {
    throw new Error(`Doc2x preupload error: ${str(pre?.message) ?? 'unknown error'}`)
  }
  const preData = asRecord(pre?.data)
  const uid = str(preData?.uid)
  const uploadUrl = str(preData?.url)
  if (uid === undefined || uploadUrl === undefined) {
    throw new Error('Doc2x preupload response missing uid/url')
  }

  await requireOk(
    await net.fetch(uploadUrl, {
      method: 'PUT',
      signal,
      body: new Uint8Array(await fsp.readFile(filePath))
    }),
    'Doc2x file upload'
  )

  await pollUntil({
    label: 'Doc2x parse',
    attempts: 3600,
    intervalMs: 1000,
    signal,
    attempt: async () => {
      const response = asRecord(
        await readJson(
          await requireOk(
            await net.fetch(`${apiHost}/api/v2/parse/status?uid=${encodeURIComponent(uid)}`, {
              headers: authHeaders,
              signal
            }),
            'Doc2x status poll'
          )
        )
      )
      if (str(response?.code) !== 'success') {
        throw new Error(`Doc2x status error: ${str(response?.message) ?? 'unknown error'}`)
      }
      const status = str(asRecord(response?.data)?.status)
      if (status === 'failed') throw new TerminalPollError('Doc2x parsing failed')
      if (status === 'success') return true
      return undefined
    }
  })

  const convert = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/api/v2/convert/parse`, {
          method: 'POST',
          signal,
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, to: 'md', formula_mode: 'normal', filename: fileNameWithoutExt(filePath) })
        }),
        'Doc2x convert request'
      )
    )
  )
  if (str(convert?.code) !== 'success') {
    throw new Error(`Doc2x convert error: ${str(convert?.message) ?? 'unknown error'}`)
  }

  const exportUrl = await pollUntil({
    label: 'Doc2x export',
    attempts: 3600,
    intervalMs: 1000,
    signal,
    attempt: async () => {
      const response = asRecord(
        await readJson(
          await requireOk(
            await net.fetch(`${apiHost}/api/v2/convert/parse/result?uid=${encodeURIComponent(uid)}`, {
              headers: authHeaders,
              signal
            }),
            'Doc2x export poll'
          )
        )
      )
      const status = str(asRecord(response?.data)?.status)
      if (status === 'failed') throw new TerminalPollError('Doc2x export failed')
      if (status === 'success') return str(asRecord(response?.data)?.url)
      return undefined
    }
  })
  return markdownFromZip(await downloadBytes(exportUrl, signal), 'Doc2x')
}

function fileNameWithoutExt(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, '')
}

/** Open MinerU（自部署）：单发 multipart 解析请求，响应即结果 zip；上游 5×5s 重试。 */
async function parseWithOpenMineru(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const apiHost = normalizeHost(config.apiHost, undefined)
  if (apiHost === undefined) {
    throw new Error('Open MinerU apiHost is not configured (设置 → 文档处理)')
  }
  await assertPdfLimits(filePath, { maxBytesMb: 200, maxPages: 600 })
  const bytes = new Uint8Array(await fsp.readFile(filePath))
  const buildBody = (): FormData => {
    const form = new FormData()
    form.append('return_md', 'true')
    form.append('response_format_zip', 'true')
    form.append('files', new Blob([bytes], { type: 'application/pdf' }), path.basename(filePath))
    return form
  }

  let lastError: unknown = new Error('Open MinerU parsing did not run')
  for (let attempt = 1; attempt <= 5; attempt++) {
    signal?.throwIfAborted()
    try {
      const response = await net.fetch(`${apiHost}/file_parse`, {
        method: 'POST',
        signal,
        headers: config.apiKey === undefined ? {} : { Authorization: `Bearer ${config.apiKey}` },
        body: buildBody()
      })
      await requireOk(response, 'Open MinerU file parse')
      if (response.headers.get('content-type') !== 'application/zip') {
        throw new Error(`Open MinerU returned unexpected content-type: ${response.headers.get('content-type')}`)
      }
      return markdownFromZip(new Uint8Array(await response.arrayBuffer()), 'Open MinerU')
    } catch (error) {
      lastError = error
      logger.warn(`Open MinerU attempt ${attempt}/5 failed`, toError(error))
      if (attempt < 5) await sleep(5000, signal)
    }
  }
  throw toError(lastError)
}

/**
 * Mistral OCR（SDK 的裸 REST 移植）：multipart 上传（purpose=ocr）→ 取签名 URL
 * （GET /v1/files/{id}/url）→ POST /v1/ocr 逐页返回 markdown。图片不作落盘——
 * 本缝只回文本，base64 图片对下游模型/向量是噪音。
 */
async function parseWithMistral(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = requireKey(config, 'Mistral')
  const apiHost = normalizeHost(config.apiHost, 'https://api.mistral.ai') as string
  const authHeaders = { Authorization: `Bearer ${apiKey}` }

  const form = new FormData()
  form.append('purpose', 'ocr')
  form.append(
    'file',
    new Blob([new Uint8Array(await fsp.readFile(filePath))], { type: 'application/pdf' }),
    path.basename(filePath)
  )
  const uploaded = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/v1/files`, { method: 'POST', signal, headers: authHeaders, body: form }),
        'Mistral file upload'
      )
    )
  )
  const fileId = str(uploaded?.id)
  if (fileId === undefined) {
    throw new Error('Mistral upload response missing file id')
  }
  const signed = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/v1/files/${fileId}/url`, { headers: authHeaders, signal }),
        'Mistral signed URL request'
      )
    )
  )
  const fileUrl = str(signed?.url)
  if (fileUrl === undefined) {
    throw new Error('Mistral signed URL response missing url')
  }

  const ocr = asRecord(
    await readJson(
      await requireOk(
        await net.fetch(`${apiHost}/v1/ocr`, {
          method: 'POST',
          signal,
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model ?? 'mistral-ocr-latest',
            document: { type: 'document_url', documentUrl: fileUrl },
            includeImageBase64: false
          })
        }),
        'Mistral OCR request'
      )
    )
  )
  const markdown = (arr(ocr?.pages) ?? [])
    .map(asRecord)
    .map((page) => str(page?.markdown) ?? '')
    .join('\n\n')
    .trim()
  if (markdown.length === 0) {
    throw new Error('Mistral OCR returned no content')
  }
  return markdown
}

/**
 * PaddleOCR 云端（aistudio）：单发 base64 JSON。上游 zod 校验在 fork 手写窄化
 * （zod 在 devDependencies，不进主进程运行时面）。上游实测边界：单文件 ≤50MB、
 * 超 100 页只解析前 100 页（静默截断）——所以页数校验必须保留。
 */
async function parseWithPaddleOcr(
  config: PreprocessProviderConfig,
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const apiHost = normalizeHost(config.apiHost, undefined)
  if (apiHost === undefined) {
    throw new Error('PaddleOCR apiHost is not configured (设置 → 文档处理)')
  }
  await assertPdfLimits(filePath, { maxBytesMb: 50, maxPages: 100 })

  const response = await requireOk(
    await net.fetch(apiHost, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Client-Platform': 'cherry-studio',
        Authorization: `token ${config.apiKey ?? ''}`
      },
      body: JSON.stringify({
        file: (await fsp.readFile(filePath)).toString('base64'),
        fileType: 0,
        useDocOrientationClassify: false,
        useDocUnwarping: false,
        useTextlineOrientation: false,
        useChartRecognition: false
      })
    }),
    'PaddleOCR API request'
  )
  const payload = asRecord(await readJson(response))
  const errorCode = Number(payload?.errorCode)
  if (Number.isFinite(errorCode) && errorCode !== 0) {
    throw new Error(`PaddleOCR API error [${errorCode}]: ${str(payload?.errorMsg) ?? 'unknown error'}`)
  }

  const result = asRecord(payload?.result)
  const layoutResults = arr(result?.layoutParsingResults)
  if (layoutResults !== undefined && layoutResults.length > 0) {
    const text = layoutResults
      .map(asRecord)
      .map((entry) => str(asRecord(entry?.markdown)?.text))
      .filter((text): text is string => text !== undefined && text.trim().length > 0)
      .join('\n\n')
      .trim()
    if (text.length > 0) return text
  }
  const ocrResults = arr(result?.ocrResults)
  if (ocrResults !== undefined && ocrResults.length > 0) {
    const text = ocrResults
      .map(asRecord)
      .map((entry) => {
        const recTexts = arr(asRecord(entry?.prunedResult)?.rec_texts) ?? []
        return recTexts.map((line) => str(line) ?? '').join('\n')
      })
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
      .trim()
    if (text.length > 0) return text
  }
  throw new Error('PaddleOCR API returned no parseable result')
}
