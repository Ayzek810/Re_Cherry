/**
 * v0.4.5-1 下载原语契约。
 *
 * 真机三类失败各对应一组断言：慢而健康的下载被杀（总时长超时）、中断后从零重来（无续传）、
 * 以及"服务端忽略 Range 时把两段数据拼在一起"（静默损坏）。main 测试环境 mock 了 node:fs，
 * 故本件通过 sink / fetchImpl 端口驱动（默认绑定见 downloadFile.ts 的 nodeDownloadSink）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createProgressThrottle,
  downloadFile,
  downloadFromAnySource,
  type DownloadProgress,
  type DownloadSink,
  selectProgressUpdate
} from '../downloadFile'

class FakeSink implements DownloadSink {
  readonly files = new Map<string, Uint8Array[]>()

  async size(target: string): Promise<number> {
    return this.bytes(target).byteLength
  }

  async append(target: string, chunk: Uint8Array): Promise<void> {
    const chunks = this.files.get(target) ?? []
    chunks.push(chunk)
    this.files.set(target, chunks)
  }

  async remove(target: string): Promise<void> {
    this.files.delete(target)
  }

  async rename(from: string, to: string): Promise<void> {
    const chunks = this.files.get(from)
    if (!chunks) throw new Error(`rename: ${from} is missing`)
    this.files.set(to, chunks)
    this.files.delete(from)
  }

  bytes(target: string): Uint8Array {
    const chunks = this.files.get(target) ?? []
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  }

  text(target: string): string {
    return Buffer.from(this.bytes(target)).toString('utf8')
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 一个读完就关的响应体；`signal` 中止时按 undici 的真实行为让读取失败。 */
function bodyFrom(chunks: Uint8Array[], signal?: AbortSignal, hangAfterLast = false): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new Error('aborted'))
        } catch {
          // 流可能已经关闭/出错——重复 error 会抛，忽略即可（测试里不影响断言）。
        }
      })
    },
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index])
        index += 1
        return
      }
      if (hangAfterLast) return new Promise<void>(() => {}) // 永不结束：等空闲超时来杀
      controller.close()
    }
  })
}

interface FakeResponseInit {
  status?: number
  contentLength?: number
  chunks?: Uint8Array[]
  hang?: boolean
}

function fakeFetch(
  calls: Array<{ url: string; headers: Record<string, string> }>,
  init: FakeResponseInit
): typeof fetch {
  return (async (url: string | URL, options?: RequestInit) => {
    const headers = (options?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), headers })
    const status = init.status ?? 200
    const signal = options?.signal ?? undefined
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(init.contentLength === undefined ? {} : { 'content-length': String(init.contentLength) }),
      body: status === 200 || status === 206 ? bodyFrom(init.chunks ?? [], signal ?? undefined, init.hang) : null
    } as unknown as Response
  }) as unknown as typeof fetch
}

const URL_UNDER_TEST = 'https://example.test/node.zip'

describe('downloadFile', () => {
  it('streams the body to <dest>.part and renames it into place', async () => {
    const sink = new FakeSink()
    const progress: DownloadProgress[] = []
    const result = await downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
      label: 'node runtime',
      sink,
      fetchImpl: fakeFetch([], { contentLength: 11, chunks: [bytes('hello '), bytes('world')] }),
      onProgress: (value) => progress.push(value)
    })

    expect(result).toEqual({ path: '/cache/downloads/node.zip', bytes: 11, resumedFrom: 0 })
    expect(sink.text('/cache/downloads/node.zip')).toBe('hello world')
    expect(sink.files.has('/cache/downloads/node.zip.part')).toBe(false)
    expect(progress.at(-1)).toEqual({ receivedBytes: 11, totalBytes: 11 })
  })

  it('resumes from an existing .part with a Range request', async () => {
    const sink = new FakeSink()
    await sink.append('/cache/downloads/node.zip.part', bytes('hello '))
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
      label: 'node runtime',
      sink,
      // 206 的 content-length 是"剩余"字节数。
      fetchImpl: fakeFetch(calls, { status: 206, contentLength: 5, chunks: [bytes('world')] })
    })

    expect(calls[0]?.headers.Range).toBe('bytes=6-')
    expect(result).toEqual({ path: '/cache/downloads/node.zip', bytes: 11, resumedFrom: 6 })
    expect(sink.text('/cache/downloads/node.zip')).toBe('hello world')
  })

  it('restarts from zero when the server ignores the Range request', async () => {
    const sink = new FakeSink()
    await sink.append('/cache/downloads/node.zip.part', bytes('stale-content'))
    const result = await downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
      label: 'node runtime',
      sink,
      // 200（而非 206）：服务端无视了 Range，两段数据拼起来就是坏档。
      fetchImpl: fakeFetch([], { contentLength: 5, chunks: [bytes('fresh')] })
    })

    expect(result.bytes).toBe(5)
    expect(sink.text('/cache/downloads/node.zip')).toBe('fresh')
  })

  it('retries a stalled transfer and keeps the bytes already received', async () => {
    const sink = new FakeSink()
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    let attempt = 0
    const fetchImpl = (async (url: string | URL, options?: RequestInit) => {
      calls.push({ url: String(url), headers: (options?.headers ?? {}) as Record<string, string> })
      attempt += 1
      if (attempt === 1) {
        // 第一轮：给两块就挂住 → 空闲超时杀掉，已收的 6 字节留在 .part。
        return {
          ok: true,
          status: 200,
          statusText: '',
          headers: new Headers({ 'content-length': '11' }),
          body: bodyFrom([bytes('hello ')], options?.signal ?? undefined, true)
        } as unknown as Response
      }
      return {
        ok: true,
        status: 206,
        statusText: '',
        headers: new Headers({ 'content-length': '5' }),
        body: bodyFrom([bytes('world')], options?.signal ?? undefined)
      } as unknown as Response
    }) as unknown as typeof fetch

    const result = await downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
      label: 'node runtime',
      sink,
      fetchImpl,
      idleTimeoutMs: 20,
      maxAttempts: 2
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers.Range).toBe('bytes=6-')
    expect(result).toEqual({ path: '/cache/downloads/node.zip', bytes: 11, resumedFrom: 6 })
    expect(sink.text('/cache/downloads/node.zip')).toBe('hello world')
  })

  it('fails on a short body instead of accepting a truncated archive', async () => {
    const sink = new FakeSink()
    await expect(
      downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
        label: 'node runtime',
        sink,
        maxAttempts: 1,
        fetchImpl: fakeFetch([], { contentLength: 100, chunks: [bytes('short')] })
      })
    ).rejects.toThrow(/incomplete download: 5\/100 bytes/)
  })

  it('does not retry a deterministic 4xx', async () => {
    const sink = new FakeSink()
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    await expect(
      downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
        label: 'node runtime',
        sink,
        maxAttempts: 3,
        fetchImpl: fakeFetch(calls, { status: 404 })
      })
    ).rejects.toThrow(/HTTP 404/)
    expect(calls).toHaveLength(1)
  })

  it('reports a stalled download when the body never produces data', async () => {
    const sink = new FakeSink()
    await expect(
      downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
        label: 'node runtime',
        sink,
        idleTimeoutMs: 20,
        maxAttempts: 1,
        fetchImpl: fakeFetch([], { contentLength: 10, chunks: [], hang: true })
      })
    ).rejects.toThrow(/stalled/)
  })
})

describe('downloadFromAnySource', () => {
  it('falls back to the next mirror and drops the previous partial file', async () => {
    const sink = new FakeSink()
    const primary = fakeFetch([], { status: 500 })
    const secondary = fakeFetch([], { contentLength: 5, chunks: [bytes('fresh')] })
    let call = 0
    const fetchImpl = (async (url: string | URL, options?: RequestInit) => {
      call += 1
      return call === 1
        ? (primary as unknown as (u: string | URL, o?: RequestInit) => Promise<Response>)(url, options)
        : (secondary as unknown as (u: string | URL, o?: RequestInit) => Promise<Response>)(url, options)
    }) as unknown as typeof fetch

    const result = await downloadFromAnySource(
      ['https://mirror-a.test/node.zip', 'https://mirror-b.test/node.zip'],
      '/cache/downloads/node.zip',
      { label: 'node runtime', sink, fetchImpl, maxAttempts: 1 }
    )

    expect(result.bytes).toBe(5)
    expect(sink.text('/cache/downloads/node.zip')).toBe('fresh')
  })
})

describe('selectProgressUpdate（进度条本体的判定）', () => {
  const mb = 1024 * 1024
  const at = (receivedBytes: number, totalBytes?: number): DownloadProgress =>
    totalBytes === undefined ? { receivedBytes } : { receivedBytes, totalBytes }

  it('reports the first sample immediately so the bar starts moving', () => {
    const throttle = createProgressThrottle()
    expect(selectProgressUpdate(throttle, at(0, 10 * mb))).toEqual({ detail: '0% · 0.0/10.0 MB', fraction: 0 })
  })

  it('throttles sub-megabyte samples and reports every whole megabyte', () => {
    const throttle = createProgressThrottle()
    selectProgressUpdate(throttle, at(0, 10 * mb))
    expect(selectProgressUpdate(throttle, at(0.4 * mb, 10 * mb))).toBeUndefined()
    expect(selectProgressUpdate(throttle, at(1 * mb, 10 * mb))).toEqual({ detail: '10% · 1.0/10.0 MB', fraction: 0.1 })
  })

  it('always reports completion, however small the last step', () => {
    const throttle = createProgressThrottle()
    selectProgressUpdate(throttle, at(9.5 * mb, 10 * mb))
    expect(selectProgressUpdate(throttle, at(9.9 * mb, 10 * mb))).toBeUndefined()
    expect(selectProgressUpdate(throttle, at(10 * mb, 10 * mb))).toEqual({
      detail: '100% · 10.0/10.0 MB',
      fraction: 1
    })
  })

  it('never reports a fraction lower than the last one (the bar cannot go backwards)', () => {
    const throttle = createProgressThrottle()
    selectProgressUpdate(throttle, at(8 * mb, 10 * mb))
    // 同一阶段换了另一份资源（分母变大）：字节数在涨、比例却掉回个位数——进度条该停在
    // 已到的位置，而不是从 80% 跳回 9%。
    expect(selectProgressUpdate(throttle, at(9 * mb, 100 * mb))).toBeUndefined()
    // 同分母下的字节回退由节流兜住（连续两次上报之间不足 1MB），两条纪律各管一段。
    expect(selectProgressUpdate(throttle, at(4 * mb, 10 * mb))).toBeUndefined()
    expect(selectProgressUpdate(throttle, at(90 * mb, 100 * mb))).toEqual({
      detail: '90% · 90.0/100.0 MB',
      fraction: 0.9
    })
  })

  it('omits the fraction when the total size is unknown (the bar stays indeterminate)', () => {
    const throttle = createProgressThrottle()
    expect(selectProgressUpdate(throttle, at(2 * mb))).toEqual({ detail: '2.0 MB' })
  })
})

describe('downloadFile failure surfaces', () => {
  it('keeps the partial file for the next attempt instead of starting over', async () => {
    const sink = new FakeSink()
    await sink.append('/cache/downloads/node.zip.part', bytes('keep-me'))
    const removeSpy = vi.spyOn(sink, 'remove')
    await expect(
      downloadFile(URL_UNDER_TEST, '/cache/downloads/node.zip', {
        label: 'node runtime',
        sink,
        maxAttempts: 1,
        fetchImpl: fakeFetch([], { status: 503 })
      })
    ).rejects.toThrow(/503/)
    expect(removeSpy).not.toHaveBeenCalled()
    expect(sink.text('/cache/downloads/node.zip.part')).toBe('keep-me')
  })
})
