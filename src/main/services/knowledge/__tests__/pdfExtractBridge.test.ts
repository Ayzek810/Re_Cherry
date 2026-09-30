/**
 * PDF 抽取 worker 桥测试（v0.4.4-2）：常驻句柄复用（beforeEach dispose 清态，
 * 每测试从全新 worker 起步）、id 关联（id 从 postMessage 调用动态取——桥的
 * nextId 跨测试递增，硬编码必漂移）、abort = kill、崩溃拒绝、产物缺失 fail-loud、
 * 引擎缝路由。worker 为 FakeChild（引擎的 pdf-parse 行为已在 extractors.test
 * 进程内真跑覆盖）。
 */
import { EventEmitter } from 'node:events'

import { utilityProcess } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { disposePdfExtractWorker, extractPdfViaWorker, installPdfWorkerExtractor } from '../pdfExtractBridge'

/** 编排层的 worker 产物存在性预检——默认产物在。 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const mock = { ...actual, existsSync: vi.fn(() => true) }
  return { ...mock, default: mock }
})

/** 断 SearchService 边（§7.15：其 BrowserWindow 具名导入在 vitest ESM interop 下炸）。 */
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: vi.fn(async () => ({ content: '' })),
  noContent: 'no content'
}))

const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}

let currentChild: FakeChild | null = null

function installFork(): void {
  vi.mocked(utilityProcess.fork).mockImplementation((() => {
    const child = new FakeChild()
    children.push(child)
    currentChild = child
    return child
  }) as unknown as typeof utilityProcess.fork)
}

const forkCount = (): number => vi.mocked(utilityProcess.fork).mock.calls.length

/** 取最后一个 extract 请求的 id（桥的 nextId 跨请求递增，硬编码必漂移）。 */
function lastExtractId(child: FakeChild): number {
  const calls = (child.postMessage).mock.calls
  for (let i = calls.length - 1; i >= 0; i--) {
    const arg = calls[i][0] as { type?: string; id?: number }
    if (arg?.type === 'extract') return arg.id as number
  }
  throw new Error('no extract job posted')
}

const emit = (child: FakeChild, message: unknown): void =>
  (child as unknown as { emit: (event: 'message', payload: unknown) => void }).emit('message', message)
const emitExit = (child: FakeChild, code: number): void =>
  (child as unknown as { emit: (event: string, code: number) => void }).emit('exit', code)

beforeEach(() => {
  installFork()
  disposePdfExtractWorker() // 清态（首个测试时 worker 尚未创建，no-op）
})

describe('extractPdfViaWorker（常驻 worker 编排）', () => {
  it('happy path：job 按 id 关联，result 回传文本，第二次抽取复用 worker', async () => {
    const forks = forkCount()
    const p1 = extractPdfViaWorker('C:/books/a.pdf')
    const child = currentChild as FakeChild
    expect(child).toBeDefined()
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extract', id: 1, filePath: 'C:/books/a.pdf' })
    )
    emit(child, { type: 'result', id: 1, text: '第一本正文' })
    await expect(p1).resolves.toBe('第一本正文')
    expect(child.kill).not.toHaveBeenCalled() // 常驻：完成不 kill

    const p2 = extractPdfViaWorker('C:/books/b.pdf')
    expect(forkCount()).toBe(forks + 1) // 仅首抽取 fork 一次
    expect(currentChild).toBe(child)
    const id2 = lastExtractId(child)
    emit(child, { type: 'result', id: id2, text: '第二本正文' })
    await expect(p2).resolves.toBe('第二本正文')
  })

  it('abort = kill worker（单次 getText 不可分页中断），promise 以中止原因拒绝', async () => {
    const controller = new AbortController()
    const promise = extractPdfViaWorker('C:/books/big.pdf', controller.signal)
    const child = currentChild as FakeChild
    expect(child).toBeDefined()
    controller.abort(new Error('user cancelled'))
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(promise).rejects.toThrow('user cancelled')
  })

  it('worker 报 error：按实际 job id 拒绝并上抛消息', async () => {
    const promise = extractPdfViaWorker('C:/books/broken.pdf')
    const child = currentChild as FakeChild
    emit(child, { type: 'error', id: lastExtractId(child), message: 'pdf parse failed' })
    await expect(promise).rejects.toThrow('pdf parse failed')
  })

  it('解析中途 worker 崩溃：拒绝；下一次抽取自动重 fork', async () => {
    const first = extractPdfViaWorker('C:/books/a.pdf')
    const child = currentChild as FakeChild
    emitExit(child, 1)
    await expect(first).rejects.toThrow('exited unexpectedly (code 1)')

    const second = extractPdfViaWorker('C:/books/b.pdf')
    const secondChild = currentChild as FakeChild
    expect(secondChild).not.toBe(child) // 崩溃后重 fork
    const id = lastExtractId(secondChild)
    emit(secondChild, { type: 'result', id, text: '恢复' })
    await expect(second).resolves.toBe('恢复')
  })

  it('空闲退出（exit 0）静默：句柄置空，下一次抽取重 fork', async () => {
    const first = extractPdfViaWorker('C:/books/a.pdf')
    const child = currentChild as FakeChild
    emit(child, { type: 'result', id: lastExtractId(child), text: '正文' })
    await expect(first).resolves.toBe('正文')
    emitExit(child, 0) // 空闲自退
    const second = extractPdfViaWorker('C:/books/b.pdf')
    const secondChild = currentChild as FakeChild
    expect(secondChild).not.toBe(child)
    emit(secondChild, { type: 'result', id: lastExtractId(secondChild), text: 'again' })
    await expect(second).resolves.toBe('again')
  })

  it('worker 产物缺失：fail-loud 不 fork', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValueOnce(false)
    const forks = forkCount()
    await expect(extractPdfViaWorker('C:/books/a.pdf')).rejects.toThrow('worker bundle is missing')
    expect(forkCount()).toBe(forks) // 不 fork
  })
})

describe('installPdfWorkerExtractor（引擎缝注入）', () => {
  it('注入后 extractFromFile 的 .pdf 走 worker（result 按 extract 的 id 回）', async () => {
    installPdfWorkerExtractor()
    const forks = forkCount()
    const { extractFromFile } = await import('../extractors')
    // override 分支不读盘（worker 自己读文件），路径仅作路由验证。
    const promise = extractFromFile('C:/books/inject.pdf')
    const child = currentChild as FakeChild
    expect(child).toBeDefined()
    emit(child, { type: 'result', id: lastExtractId(child), text: '注入缝正文' })
    await expect(promise).resolves.toEqual({ text: '注入缝正文', source: 'inject.pdf' })
    expect(forkCount()).toBe(forks + 1)
  })
})
