/**
 * 文档处理通道行为测试（§7.17 三轮：ocr_document 挂进文档处理通道）。
 * - 注册表：配置投影 / 每轮服务商登记（webSearch 同构语义）；
 * - 路由：local-paddle → 本地 OCR 编排；未知 id 明错；时间预算（8 分钟默认，
 *   可传 Infinity）经 AbortController 打断在途工作；
 * - 云端适配器（net.fetch 全 mock + 真 Response）：MinerU 四步流 / Doc2x 五步流 /
 *   Mistral 裸 REST / PaddleOCR base64 / Open MinerU zip，以及各自失败路径；
 * - zip 产物解包：真字节 zip（stored 无压缩，手工构造）→ 取层级最浅 .md。
 * node:fs/promises 未被 main.setup mock（真实临时文件可用）；node:os 的 tmpdir
 * 被 setup mock 漏掉，本文件局部补真值。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const patched = { ...actual, tmpdir: () => process.env.TEMP ?? process.env.TMP ?? '.' }
  return { ...patched, default: patched }
})

vi.mock('@main/services/localModel/pdfOcr', () => ({
  ocrPdfFile: vi.fn(),
  terminateActiveOcrProcess: vi.fn(async () => {})
}))

import { ocrPdfFile } from '@main/services/localModel/pdfOcr'

import {
  isProviderConfigured,
  parsePdfWithProvider,
  preprocessChannel,
  TOOL_OCR_TIME_BUDGET_MS
} from '../preprocessChannel'
import { buildZip } from './zipTestHelper'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'preprocess-channel-test-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true })
    dir = ''
  }
})

async function writeTemp(name: string, content: Buffer | string): Promise<string> {
  const filePath = path.join(dir, name)
  await writeFile(filePath, content)
  return filePath
}

// ---- 真 PDF（复用 extractors.test 的最小合成法；页数校验走真 pdf-parse）----

function buildPdf(pageTexts: string[]): Buffer {
  const objs: string[] = []
  const pageObjNums = pageTexts.map((_, i) => 4 + i * 2)
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, i) => {
    const escaped = text.replace(/([()\\])/g, '\\$1')
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    objs[pageObjNums[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${pageObjNums[i] + 1} 0 R >>`
    objs[pageObjNums[i] + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let n = 1; n < objs.length; n++) pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

// ---- 真 zip（stored 无压缩，手工构造；node-stream-zip 真解包；构建器在 zipTestHelper）----

// ---- net.fetch 序列桩 ----

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const bytesResponse = (bytes: Uint8Array, contentType = 'application/zip'): Response =>
  new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType } })

/** 按 URL 片段路由的 fetch 桩（记录调用便于断言请求形状；具体片段必须排在
 * 泛化片段之前——find 按序命中，/v1/files 会吃掉 /v1/files/f1/url）。 */
function stubFetch(routes: Array<{ match: string; respond: (url: string, init?: RequestInit) => Response }>): void {
  vi.mocked(net.fetch).mockImplementation(async (input: unknown, init?: unknown) => {
    const url = String(input)
    const route = routes.find((r) => url.includes(r.match))
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    return route.respond(url, init as RequestInit | undefined)
  })
}

describe('preprocessChannel 注册表（配置投影 + 每轮登记）', () => {
  it('setConfig 整体替换；getConfig 按 id 反查', () => {
    preprocessChannel.setConfig([
      { id: 'mineru', apiKey: 'k1' },
      { id: 'doc2x', apiKey: 'k2' }
    ])
    expect(preprocessChannel.getConfig('mineru')).toEqual({ id: 'mineru', apiKey: 'k1' })
    expect(preprocessChannel.getConfig('doc2x')).toEqual({ id: 'doc2x', apiKey: 'k2' })
    preprocessChannel.setConfig([])
    expect(preprocessChannel.getConfig('mineru')).toBeUndefined()
  })

  it('setTurnProvider 即设即覆盖；undefined = 清除', () => {
    preprocessChannel.setTurnProvider('t1', 'mineru')
    expect(preprocessChannel.getTurnProviderId('t1')).toBe('mineru')
    preprocessChannel.setTurnProvider('t1', undefined)
    expect(preprocessChannel.getTurnProviderId('t1')).toBeUndefined()
  })

  it('isProviderConfigured：按服务商就绪条件分派', () => {
    expect(isProviderConfigured({ id: 'local-paddle' })).toBe(true)
    expect(isProviderConfigured({ id: 'mineru', apiKey: 'k' })).toBe(true)
    expect(isProviderConfigured({ id: 'mineru' })).toBe(false)
    expect(isProviderConfigured({ id: 'mistral', apiKey: 'k' })).toBe(true)
    expect(isProviderConfigured({ id: 'open-mineru', apiHost: 'http://h' })).toBe(true)
    expect(isProviderConfigured({ id: 'open-mineru' })).toBe(false)
    expect(isProviderConfigured({ id: 'paddleocr', apiKey: 'k', apiHost: 'http://h' })).toBe(true)
    expect(isProviderConfigured({ id: 'paddleocr', apiKey: 'k' })).toBe(false)
    expect(isProviderConfigured({ id: 'nope' })).toBe(false)
  })
})

describe('parsePdfWithProvider 路由与时间预算', () => {
  it('local-paddle → 本地 OCR 编排（signal 透传）', async () => {
    vi.mocked(ocrPdfFile).mockResolvedValue('本地 OCR 全文')
    const text = await parsePdfWithProvider({ id: 'local-paddle' }, 'C:/books/scan.pdf')
    expect(ocrPdfFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ocrPdfFile).mock.calls[0][0]).toBe('C:/books/scan.pdf')
    expect(vi.mocked(ocrPdfFile).mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(text).toBe('本地 OCR 全文')
  })

  it('未知服务商 id：明错并列出支持面', async () => {
    await expect(parsePdfWithProvider({ id: 'nope' }, 'C:/books/a.pdf')).rejects.toThrow(
      /unknown document-processing provider "nope"/
    )
  })

  it('默认时间预算 = 8 分钟（用户裁决放宽值）', () => {
    expect(TOOL_OCR_TIME_BUDGET_MS).toBe(8 * 60 * 1000)
  })

  it('时间预算到点：打断在途工作并给可行动错误', async () => {
    vi.mocked(ocrPdfFile).mockImplementation(
      (_filePath: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    await expect(
      parsePdfWithProvider({ id: 'local-paddle' }, 'C:/books/big.pdf', undefined, { budgetMs: 50 })
    ).rejects.toThrow(/time budget \(1 min\) exceeded/)
  }, 5000)

  it('外部 signal 中止：透传打断', async () => {
    vi.mocked(ocrPdfFile).mockImplementation(
      (_filePath: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const controller = new AbortController()
    const pending = parsePdfWithProvider({ id: 'local-paddle' }, 'C:/books/a.pdf', controller.signal)
    controller.abort(new Error('user cancelled'))
    await expect(pending).rejects.toThrow('user cancelled')
  })
})

describe('MinerU 适配器（四步流）', () => {
  it('happy path：申请直传 URL → PUT → 轮询 done → zip 取 md', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['MinerU test page with enough body text.']))
    const zipBytes = buildZip([{ name: 'book/auto/book.md', data: Buffer.from('# MinerU 结果\n\n正文') }])
    const calls: string[] = []
    stubFetch([
      {
        match: '/api/v4/file-urls/batch',
        respond: (_url, init) => {
          calls.push(`POST ${String((init?.headers as Record<string, string>)?.Authorization)}`)
          return jsonResponse({ code: 0, data: { batch_id: 'b1', file_urls: ['https://put.example.com/u1'] } })
        }
      },
      {
        match: 'https://put.example.com/u1',
        respond: (_url, init) => {
          calls.push(`PUT body=${init?.body instanceof Uint8Array ? init.body.length : 'none'}`)
          return new Response(null, { status: 200 })
        }
      },
      {
        match: '/api/v4/extract-results/batch/b1',
        respond: () => {
          calls.push('POLL')
          return jsonResponse({
            code: 0,
            data: {
              extract_result: [{ file_name: 'book.pdf', state: 'done', full_zip_url: 'https://zip.example.com/z' }]
            }
          })
        }
      },
      { match: 'https://zip.example.com/z', respond: () => bytesResponse(zipBytes) }
    ])

    const text = await parsePdfWithProvider({ id: 'mineru', apiKey: 'mk' }, pdfPath)

    expect(calls[0]).toBe('POST Bearer mk')
    expect(calls[1]).toBe('PUT body=' + (await writeFile_getLength(pdfPath)))
    expect(calls.filter((c) => c === 'POLL')).toHaveLength(1)
    expect(text).toBe('# MinerU 结果\n\n正文')
  })

  it('state=failed：err_msg 如实上抛', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    stubFetch([
      {
        match: '/api/v4/file-urls/batch',
        respond: () => jsonResponse({ code: 0, data: { batch_id: 'b2', file_urls: ['https://put.example.com/u'] } })
      },
      { match: 'https://put.example.com/u', respond: () => new Response(null, { status: 200 }) },
      {
        match: '/api/v4/extract-results/batch/b2',
        respond: () =>
          jsonResponse({
            code: 0,
            data: { extract_result: [{ file_name: 'book.pdf', state: 'failed', err_msg: 'OOM on server' }] }
          })
      }
    ])
    await expect(parsePdfWithProvider({ id: 'mineru', apiKey: 'mk' }, pdfPath)).rejects.toThrow(
      'MinerU parsing failed: OOM on server'
    )
  })
})

describe('Doc2x 适配器（五步流）', () => {
  it('happy path：preupload → PUT → 解析轮询 → 导出轮询 → zip 取 md', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['Doc2x test page with enough body text.']))
    const zipBytes = buildZip([{ name: 'book.md', data: Buffer.from('# Doc2x 结果') }])
    stubFetch([
      {
        match: '/api/v2/parse/preupload',
        respond: () => jsonResponse({ code: 'success', data: { uid: 'u1', url: 'https://put.example.com/d1' } })
      },
      { match: 'https://put.example.com/d1', respond: () => new Response(null, { status: 200 }) },
      {
        match: '/api/v2/parse/status',
        respond: () => jsonResponse({ code: 'success', data: { status: 'success', progress: 100 } })
      },
      {
        match: '/api/v2/convert/parse/result',
        respond: () => jsonResponse({ code: 'success', data: { status: 'success', url: 'https://zip.example.com/d' } })
      },
      {
        match: '/api/v2/convert/parse',
        respond: () => jsonResponse({ code: 'success', data: {} })
      },
      { match: 'https://zip.example.com/d', respond: () => bytesResponse(zipBytes) }
    ])
    const text = await parsePdfWithProvider({ id: 'doc2x', apiKey: 'dk' }, pdfPath)
    expect(text).toBe('# Doc2x 结果')
  })
})

describe('Mistral 适配器（裸 REST）', () => {
  it('happy path：上传 → 签名 URL → OCR 逐页 markdown 拼接', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['Mistral test page with enough body text.']))
    stubFetch([
      { match: '/v1/files/f1/url', respond: () => jsonResponse({ url: 'https://signed.example.com/s' }) },
      { match: '/v1/files', respond: () => jsonResponse({ id: 'f1' }) },
      {
        match: '/v1/ocr',
        respond: () => jsonResponse({ pages: [{ markdown: '# 第 1 页' }, { markdown: '第 2 页正文' }] })
      }
    ])
    const text = await parsePdfWithProvider({ id: 'mistral', apiKey: 'sk' }, pdfPath)
    expect(text).toBe('# 第 1 页\n\n第 2 页正文')
  })

  it('OCR 响应空：明错', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    stubFetch([
      { match: '/v1/files/f1/url', respond: () => jsonResponse({ url: 'https://signed.example.com/s' }) },
      { match: '/v1/files', respond: () => jsonResponse({ id: 'f1' }) },
      { match: '/v1/ocr', respond: () => jsonResponse({ pages: [] }) }
    ])
    await expect(parsePdfWithProvider({ id: 'mistral', apiKey: 'sk' }, pdfPath)).rejects.toThrow(
      'Mistral OCR returned no content'
    )
  })
})

describe('PaddleOCR 适配器（base64 单发）', () => {
  it('layoutParsingResults → markdown.text 拼接', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['Paddle test page with enough body text.']))
    stubFetch([
      {
        match: 'paddle',
        respond: () =>
          jsonResponse({
            errorCode: 0,
            result: { layoutParsingResults: [{ markdown: { text: '# 版面结果' } }, { markdown: { text: '第二页' } }] }
          })
      }
    ])
    const text = await parsePdfWithProvider(
      { id: 'paddleocr', apiKey: 'pk', apiHost: 'https://paddle.example.com' },
      pdfPath
    )
    expect(text).toBe('# 版面结果\n\n第二页')
  })

  it('errorCode 非 0：errorMsg 上抛', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    stubFetch([{ match: 'paddle', respond: () => jsonResponse({ errorCode: 3, errorMsg: 'quota exceeded' }) }])
    await expect(
      parsePdfWithProvider({ id: 'paddleocr', apiKey: 'pk', apiHost: 'https://paddle.example.com' }, pdfPath)
    ).rejects.toThrow('PaddleOCR API error [3]: quota exceeded')
  })
})

describe('Open MinerU 适配器（单发 zip）', () => {
  it('happy path：multipart 解析 → zip 取 md', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['Open MinerU test page with enough body text.']))
    const zipBytes = buildZip([{ name: 'out.md', data: Buffer.from('# 自部署结果') }])
    stubFetch([{ match: '/file_parse', respond: () => bytesResponse(zipBytes) }])
    const text = await parsePdfWithProvider({ id: 'open-mineru', apiHost: 'https://om.example.com' }, pdfPath)
    expect(text).toBe('# 自部署结果')
  })

  it('apiHost 未配置：可行动错误', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    await expect(parsePdfWithProvider({ id: 'open-mineru' }, pdfPath)).rejects.toThrow(
      'Open MinerU apiHost is not configured'
    )
  })
})

describe('zip 产物解包', () => {
  it('多 .md 时取目录层级最浅的（MinerU 新版多套一层目录）', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    const zipBytes = buildZip([
      { name: 'book/auto/deep.md', data: Buffer.from('deep') },
      { name: 'book/shallow.md', data: Buffer.from('shallow') }
    ])
    stubFetch([
      {
        match: '/api/v4/file-urls/batch',
        respond: () => jsonResponse({ code: 0, data: { batch_id: 'b3', file_urls: ['https://put.example.com/u'] } })
      },
      { match: 'https://put.example.com/u', respond: () => new Response(null, { status: 200 }) },
      {
        match: '/api/v4/extract-results/batch/b3',
        respond: () =>
          jsonResponse({
            code: 0,
            data: {
              extract_result: [{ file_name: 'book.pdf', state: 'done', full_zip_url: 'https://zip.example.com/z' }]
            }
          })
      },
      { match: 'https://zip.example.com/z', respond: () => bytesResponse(zipBytes) }
    ])
    await expect(parsePdfWithProvider({ id: 'mineru', apiKey: 'mk' }, pdfPath)).resolves.toBe('shallow')
  })

  it('zip 里没有 .md：明错', async () => {
    const pdfPath = await writeTemp('book.pdf', buildPdf(['page']))
    const zipBytes = buildZip([{ name: 'images/img.png', data: Buffer.from('png') }])
    stubFetch([
      {
        match: '/api/v4/file-urls/batch',
        respond: () => jsonResponse({ code: 0, data: { batch_id: 'b4', file_urls: ['https://put.example.com/u'] } })
      },
      { match: 'https://put.example.com/u', respond: () => new Response(null, { status: 200 }) },
      {
        match: '/api/v4/extract-results/batch/b4',
        respond: () =>
          jsonResponse({
            code: 0,
            data: {
              extract_result: [{ file_name: 'book.pdf', state: 'done', full_zip_url: 'https://zip.example.com/z' }]
            }
          })
      },
      { match: 'https://zip.example.com/z', respond: () => bytesResponse(zipBytes) }
    ])
    await expect(parsePdfWithProvider({ id: 'mineru', apiKey: 'mk' }, pdfPath)).rejects.toThrow(
      'result zip contains no markdown file'
    )
  })
})

/** 测试辅助：文件字节数（PUT body 断言用）。 */
async function writeFile_getLength(filePath: string): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  return (await readFile(filePath)).length
}
