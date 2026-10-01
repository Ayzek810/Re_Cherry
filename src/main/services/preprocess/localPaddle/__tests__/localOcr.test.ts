/**
 * LocalPaddle OCR 编排测试（常驻 worker + 页级并发 + 打断交缓存语义）：
 * - 常驻：worker 句柄跨解析/跨测试复用（FakeChild 模块级共享），结束不 kill；
 *   断言用 forkCount 增量而非 children 数组（旧世界是"每次解析必 fork"）；
 * - 信用窗：job 带 window，页消息即时回信；
 * - terminate：kill 常驻 worker 并等 exit（删模型前置）；
 * - 打断交缓存：abort → 发 cancel → 已完成页 + 截断说明；零完成拒绝；
 * - 崩溃：解析中 exit 如实拒绝，下一次解析重 fork。
 */
import { EventEmitter } from 'node:events'

import { utilityProcess } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runLocalOcr, terminateActiveOcrProcess } from '../localOcr'

vi.mock('@main/services/preprocess/localPaddle/modelStore', () => ({
  isPaddleModelReady: vi.fn(() => true),
  paddleModelPaths: vi.fn(() => ({
    detection: 'det.onnx',
    recognition: 'rec.onnx',
    charactersDictionary: 'dict.txt'
  }))
}))

/** 编排层的 worker 产物存在性预检——默认产物在。 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const mock = { ...actual, existsSync: vi.fn(() => true) }
  return { ...mock, default: mock }
})

/** 常驻 worker 的当前 FakeChild（跨解析/跨测试复用——常驻语义本体）。 */
let currentChild: FakeChild | null = null
const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}

function installFork(): void {
  vi.mocked(utilityProcess.fork).mockImplementation((() => {
    const child = new FakeChild()
    children.push(child)
    currentChild = child
    return child
  }) as unknown as typeof utilityProcess.fork)
}

const forkCount = (): number => vi.mocked(utilityProcess.fork).mock.calls.length

/** EventEmitter 原生 emit——child.on('message'/'exit') 的回调同步收到载荷。 */
const emit = (child: FakeChild, message: unknown): void =>
  (child as unknown as { emit: (event: 'message', payload: unknown) => void }).emit('message', message)
const emitExit = (child: FakeChild, code: number): void =>
  (child as unknown as { emit: (event: string, code: number) => void }).emit('exit', code)

/** 本地页消费是同步的（map.set + 回信），发页消息即可断言。 */
function feedPage(child: FakeChild, page: number, totalPages: number, text = `第${page}页`): void {
  emit(child, { type: 'page', page, totalPages, text })
}

function startParse(
  filePath: string,
  options?: { concurrency?: number; gpuAcceleration?: boolean },
  signal?: AbortSignal
): { promise: Promise<string>; child: FakeChild } {
  const promise = runLocalOcr(filePath, options ?? {}, signal)
  const child = currentChild
  expect(child).toBeDefined()
  return { promise, child: child as FakeChild }
}

beforeEach(() => {
  installFork()
})

describe('runLocalOcr（常驻 worker 编排）', () => {
  it('happy path：job 带 window（缺省 5）、页文本按序拼装、结束不 kill（热模型保留）', async () => {
    const forks = forkCount()
    const { promise, child } = startParse('C:/books/a.pdf')
    expect(vi.mocked(utilityProcess.fork)).toHaveBeenCalledWith(
      expect.stringContaining('localOcrWorker.js'),
      [],
      expect.objectContaining({ serviceName: 'localOcrWorker', stdio: 'pipe' })
    )
    expect(child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'job', pdfPath: 'C:/books/a.pdf', scale: 3, window: 5 })
    )
    feedPage(child, 1, 2, '第一页')
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'next' })
    feedPage(child, 2, 2, '第二页')
    emit(child, { type: 'done', pagesDone: 2, totalPages: 2 })
    await expect(promise).resolves.toBe('第一页\n\n第二页')
    // 常驻语义：解析结束不 kill（与 前"结束即 kill"相反）
    expect(child.kill).not.toHaveBeenCalled()
    expect(forkCount()).toBe(forks + 1)
  })

  it('并发透传：options.concurrency 进 job.window', async () => {
    const { promise, child } = startParse('C:/books/a.pdf', { concurrency: 12 })
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'job', window: 12 }))
    // 结算解析，不堵串行队列（后续测试的解析要过这条队）
    feedPage(child, 1, 1, '页')
    emit(child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(promise).resolves.toBe('页')
  })

  it('GPU 开关：缺省 job.gpu=true；gpuAcceleration:false → job.gpu=false', async () => {
    const first = startParse('C:/books/a.pdf')
    expect(first.child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'job', gpu: true }))
    feedPage(first.child, 1, 1, '页')
    emit(first.child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(first.promise).resolves.toBe('页')

    const second = startParse('C:/books/b.pdf', { gpuAcceleration: false })
    expect(second.child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'job', gpu: false }))
    feedPage(second.child, 1, 1, '页')
    emit(second.child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(second.promise).resolves.toBe('页')
  })

  it('复用：第二次解析不重新 fork（热模型），消息路由到当前解析', async () => {
    const first = startParse('C:/books/a.pdf')
    const forks = forkCount()
    feedPage(first.child, 1, 1, 'A 页')
    emit(first.child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(first.promise).resolves.toBe('A 页')

    const second = startParse('C:/books/b.pdf')
    expect(forkCount()).toBe(forks) // 常驻：不重 fork
    expect(second.child).toBe(first.child)
    expect(second.child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'job', pdfPath: 'C:/books/b.pdf' })
    )
    feedPage(second.child, 1, 1, 'B 页')
    emit(second.child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(second.promise).resolves.toBe('B 页')
  })

  it('打断交缓存（用户裁定）：abort 发 cancel，已完成页 + 截断说明交回，零完成拒绝', async () => {
    const controller = new AbortController()
    const { promise, child } = startParse('C:/books/a.pdf', undefined, controller.signal)
    feedPage(child, 1, 3, '已完成页')
    controller.abort(new Error('time budget'))
    await expect(promise).resolves.toBe(
      '已完成页\n\n[Local OCR interrupted at page 1 of 3 — time budget exhausted or operation cancelled; the text above covers completed pages only.]'
    )
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'cancel' })
    expect(child.kill).not.toHaveBeenCalled() // 常驻：取消不杀进程
  })

  it('打断时零完成页：无缓存可交，照旧拒绝', async () => {
    const controller = new AbortController()
    const { promise } = startParse('C:/books/a.pdf', undefined, controller.signal)
    controller.abort(new Error('user cancelled'))
    await expect(promise).rejects.toThrow('user cancelled')
  })

  it('空页贡献空文本；worker 报 error 照旧整本拒绝', async () => {
    const { promise, child } = startParse('C:/books/a.pdf')
    feedPage(child, 1, 2, '')
    emit(child, { type: 'error', message: '识别失败' })
    await expect(promise).rejects.toThrow('识别失败')
  })

  it('解析中途 worker 崩溃：如实拒绝；下一次解析自动重 fork', async () => {
    const first = startParse('C:/books/a.pdf')
    const forks = forkCount()
    emitExit(first.child, 1)
    await expect(first.promise).rejects.toThrow('exited unexpectedly')

    const second = startParse('C:/books/b.pdf')
    expect(forkCount()).toBe(forks + 1) // 崩溃后重 fork
    expect(second.child).not.toBe(first.child)
    feedPage(second.child, 1, 1, '恢复页')
    emit(second.child, { type: 'done', pagesDone: 1, totalPages: 1 })
    await expect(second.promise).resolves.toBe('恢复页')
  })
})

describe('terminateActiveOcrProcess（删模型前置）', () => {
  it('kill 常驻 worker 并等真正退出；被终止解析侧如实报错', async () => {
    const { promise, child } = startParse('C:/books/a.pdf')
    feedPage(child, 1, 2, '部分')
    let returned = false
    const terminatePromise = terminateActiveOcrProcess().then(() => {
      returned = true
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(returned).toBe(false) // 未收到 exit 前不返回（Windows 句柄未释放）
    emitExit(child, 0)
    await terminatePromise
    expect(returned).toBe(true)
    await expect(promise).rejects.toThrow() // 被 terminate 的解析如实报错不悬挂
  })

  it('无 worker：直接返回', async () => {
    await terminateActiveOcrProcess()
    expect(currentChild === null || children.includes(currentChild)).toBe(true)
  })
})
