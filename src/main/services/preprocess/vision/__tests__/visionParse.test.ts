/**
 * 视觉模型文档解析编排测试（v0.4.4）：utility 子进程协议（ping-pong 有界内存）、
 * 逐页模型调用与拼装、空页跳过、失败/abort/产物缺失语义。
 * 被测缝：runVisionDocumentParse（visionWorker 为 FakeChild，模型调用 mock）。
 */
import { EventEmitter } from 'node:events'

import { utilityProcess } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { localOcrWorkerPath } from '../../localPaddle/localOcr'
import { runVisionDocumentParse, visionWorkerPath } from '../visionParse'

/** 逐页模型调用 mock（真 HTTP 不在单元面；行为实证见 tools/scratch-verify probe G）。 */
vi.mock('@main/kernel/lightLlmModalities', () => ({
  lightVisionDocument: vi.fn()
}))

// 编排层的 worker 产物存在性预检走 node:fs.existsSync——setup 的 mock 无默认行为，
// 这里默认 true（产物在），缺产物用例单独翻 false。
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const mock = { ...actual, existsSync: vi.fn(() => true) }
  return { ...mock, default: mock }
})

import { lightVisionDocument } from '@main/kernel/lightLlmModalities'

const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}

/** setup 全局 mock 的 utilityProcess.fork 换成推 FakeChild 的实现（同步、无竞态）。 */
function installFork(): void {
  vi.mocked(utilityProcess.fork).mockImplementation((() => {
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof utilityProcess.fork)
}

const emit = (child: FakeChild, message: unknown): void =>
  (child as unknown as { emit: (event: 'message', payload: unknown) => void }).emit('message', message)

/**
 * 启动一次解析并同步取回 promise 与子进程（fork 前链路完全同步）。
 * 陷阱同 localOcr.test：promise 不得经 async 辅助函数 return（await 会同化 thenable）。
 */
function startParse(filePath: string, signal?: AbortSignal): { promise: Promise<string>; child: FakeChild } {
  const promise = runVisionDocumentParse(filePath, { provider: 'stub', model: 'vision-1' }, signal)
  const child = children[children.length - 1]
  expect(child).toBeDefined()
  return { promise, child }
}

/** 一页的完整往返：发页图 → 模型调用（由用例 mock）→ 断言放行下一页。 */
async function feedPage(child: FakeChild, page: number, totalPages: number, data = 'UE5H'): Promise<void> {
  emit(child, { type: 'page', page, totalPages, mediaType: 'image/png', data })
  // 让 consumePage 的 await 链推进（模型 mock 立即兑现）。
  await Promise.resolve()
  await Promise.resolve()
}

describe('runVisionDocumentParse（utilityProcess 编排）', () => {
  beforeEach(() => {
    children.length = 0
    vi.clearAllMocks()
    installFork()
  })

  it('happy path：逐页模型调用（页图 data URL 形态）→ 放行下一页 → 按序拼装', async () => {
    vi.mocked(lightVisionDocument)
      .mockResolvedValueOnce('# 第一页\n\n正文 A')
      .mockResolvedValueOnce('# 第二页\n\n正文 B')
    const { promise, child } = startParse('C:/books/scan.pdf')
    // 产物路径锚定 app 根（不经 __dirname——编排层会被拆 chunk）；任务带信用窗（缺省 8）。
    expect(vi.mocked(utilityProcess.fork)).toHaveBeenCalledWith(
      expect.stringContaining('visionWorker.js'),
      [],
      expect.objectContaining({ serviceName: 'visionDocumentWorker', stdio: 'pipe' })
    )
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ pdfPath: 'C:/books/scan.pdf', scale: 2, window: 8 })
    )

    await feedPage(child, 1, 2)
    expect(vi.mocked(lightVisionDocument)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(lightVisionDocument).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        providerId: 'stub',
        modelId: 'vision-1',
        images: [{ mediaType: 'image/png', data: 'UE5H' }]
      })
    )
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'next' })

    await feedPage(child, 2, 2, 'UE5I')
    expect(vi.mocked(lightVisionDocument)).toHaveBeenCalledTimes(2)
    emit(child, { type: 'done', totalPages: 2 })
    await expect(promise).resolves.toBe('# 第一页\n\n正文 A\n\n# 第二页\n\n正文 B')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('并发信用窗：两页同时在途（无需等第一页结算）、乱序完成仍按页序拼装', async () => {
    const deferred: Array<(value: string) => void> = []
    vi.mocked(lightVisionDocument).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          deferred.push(resolve)
        })
    )
    const { promise, child } = startParse('C:/books/scan.pdf')
    // 信用窗内两页都到达：主进程不等第一页结算就起第二路调用
    emit(child, { type: 'page', page: 1, totalPages: 2, mediaType: 'image/png', data: 'UE5H' })
    emit(child, { type: 'page', page: 2, totalPages: 2, mediaType: 'image/png', data: 'UE5I' })
    expect(vi.mocked(lightVisionDocument)).toHaveBeenCalledTimes(2)

    deferred[1]('第二页') // 第 2 页先完成
    await Promise.resolve()
    await Promise.resolve()
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'next' })
    deferred[0]('第一页')
    // 协议时序：'done' 经 worker IPC 异步到达，必须让页 1 的结算续体先落地。
    await Promise.resolve()
    await Promise.resolve()
    emit(child, { type: 'done', totalPages: 2 })
    await expect(promise).resolves.toBe('第一页\n\n第二页')
  })

  it('done 早于模型返回到达（信用窗下 worker 跑在消费前面）：排空在途后交全量结果', async () => {
    const deferred: Array<(value: string) => void> = []
    vi.mocked(lightVisionDocument).mockImplementation(
      () => new Promise<string>((resolve) => { deferred.push(resolve) })
    )
    const { promise, child } = startParse('C:/books/scan.pdf')
    emit(child, { type: 'page', page: 1, totalPages: 2, mediaType: 'image/png', data: 'UE5H' })
    emit(child, { type: 'page', page: 2, totalPages: 2, mediaType: 'image/png', data: 'UE5I' })
    emit(child, { type: 'done', totalPages: 2 }) // worker 先跑完：done 时两页都还在途
    deferred[1]('第二页')
    await Promise.resolve()
    await Promise.resolve()
    deferred[0]('第一页')
    await Promise.resolve()
    await Promise.resolve()
    await expect(promise).resolves.toBe('第一页\n\n第二页')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('打断交缓存（用户裁定）：预算/中止时已完成页按序交回 + 截断说明', async () => {
    vi.mocked(lightVisionDocument).mockResolvedValueOnce('第一页内容')
    const controller = new AbortController()
    const { promise, child } = startParse('C:/books/a.pdf', controller.signal)
    await feedPage(child, 1, 3)
    expect(vi.mocked(lightVisionDocument)).toHaveBeenCalledTimes(1)
    controller.abort(new Error('time budget'))
    await expect(promise).resolves.toBe(
      '第一页内容\n\n[Vision document parse interrupted at page 1 of 3 — time budget exhausted or operation cancelled; the text above covers completed pages only.]'
    )
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('打断时零完成页：无缓存可交，照旧拒绝', async () => {
    const controller = new AbortController()
    const { promise } = startParse('C:/books/a.pdf', controller.signal)
    controller.abort(new Error('user cancelled'))
    await expect(promise).rejects.toThrow('user cancelled')
  })

  it('空页（光栅化不出）：不调模型、仍结算回信、贡献空文本', async () => {
    vi.mocked(lightVisionDocument).mockResolvedValueOnce('只有第二页')
    const { promise, child } = startParse('C:/books/scan.pdf')
    await feedPage(child, 1, 2, '')
    expect(vi.mocked(lightVisionDocument)).not.toHaveBeenCalled()
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'next' })
    await feedPage(child, 2, 2)
    emit(child, { type: 'done', totalPages: 2 })
    await expect(promise).resolves.toBe('只有第二页')
  })

  it('模型回空文本的页不产出内容（整本仍可成）', async () => {
    vi.mocked(lightVisionDocument).mockResolvedValue('   ')
    const { promise, child } = startParse('C:/books/scan.pdf')
    await feedPage(child, 1, 1)
    emit(child, { type: 'done', totalPages: 1 })
    await expect(promise).rejects.toThrow('produced no text')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('模型调用失败：整本拒绝并上抛（不静默降级成空页）', async () => {
    vi.mocked(lightVisionDocument).mockRejectedValueOnce(new Error('vision document request failed (429): busy'))
    const { promise, child } = startParse('C:/books/scan.pdf')
    emit(child, { type: 'page', page: 1, totalPages: 3, mediaType: 'image/png', data: 'UE5H' })
    await expect(promise).rejects.toThrow('failed (429): busy')
    expect(child.kill).toHaveBeenCalledTimes(1)
    // 失败后不放行下一页（worker 被 kill）
    expect(child.postMessage).not.toHaveBeenCalledWith({ type: 'next' })
  })

  it('worker 报 error / 意外退出：如实上抛', async () => {
    const first = startParse('C:/books/a.pdf')
    emit(first.child, { type: 'error', message: 'pdf parse failed' })
    await expect(first.promise).rejects.toThrow('pdf parse failed')

    const second = startParse('C:/books/b.pdf')
    ;(second.child as unknown as { emit: (event: string, code: number) => void }).emit('exit', 1)
    await expect(second.promise).rejects.toThrow('exited unexpectedly (code 1)')
  })

  it('abort：立即拒绝并终止子进程', async () => {
    const controller = new AbortController()
    const { promise, child } = startParse('C:/books/a.pdf', controller.signal)
    controller.abort(new Error('budget exceeded'))
    await expect(promise).rejects.toThrow('budget exceeded')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('worker 产物缺失：不起子进程直接报构建缺口错误', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValueOnce(false)
    await expect(runVisionDocumentParse('C:/books/a.pdf', { provider: 'stub', model: 'm' })).rejects.toThrow(
      'vision document worker bundle is missing'
    )
    expect(children).toHaveLength(0)
  })
})

describe('visionWorkerPath（产物路径锚定）', () => {
  it('锚定 app 根的 out/main/visionWorker.js（与 localOcr 同判据，不随 chunk 位置漂移）', () => {
    expect(visionWorkerPath()).toBe('/mock/appRoot/out/main/visionWorker.js')
    expect(visionWorkerPath()).not.toBe(localOcrWorkerPath())
  })
})
