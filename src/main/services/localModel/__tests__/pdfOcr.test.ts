import { EventEmitter } from 'node:events'

import { utilityProcess } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { disposeOcrServiceThen } from '../ocrInferenceService'
import { ocrPdfFile, terminateActiveOcrProcess } from '../pdfOcr'

const children: FakeChild[] = []

class FakeChild extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}

// tests/main.setup.ts 全局 mock 了 electron（含 utilityProcess.fork: vi.fn() 无实现）。
// 此处静态 import 同一 mock，beforeEach 装行为——每个 FakeChild 自带独立
// postMessage/kill vi.fn，跨用例无串扰，无需 clearAllMocks。
vi.mock('@main/services/localModel/ocrPaths', () => ({
  isLocalOcrModelDownloaded: vi.fn(() => true),
  ocrModelPaths: vi.fn(() => ({
    detection: 'det.onnx',
    recognition: 'rec.onnx',
    charactersDictionary: 'dict.txt'
  }))
}))

/** EventEmitter 原生 emit（event, ...args）——child.on('message', fn) 的 fn 收到的是 payload。 */
const emit = (child: FakeChild, message: unknown): void =>
  (child as unknown as { emit: (event: 'message', payload: unknown) => void }).emit('message', message)

/** 把 setup 全局 mock 的 utilityProcess.fork 换成推 FakeChild 的实现（同步、无竞态）。 */
function installFork(): void {
  vi.mocked(utilityProcess.fork).mockImplementation((() => {
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof utilityProcess.fork)
}

/**
 * 启动一次 OCR 并同步取回 promise 与子进程。ocrPdfFile 静态链路（模型检查、
 * fork、postMessage）完全同步，调用返回时 FakeChild 已就位——无需任何 flush。
 *
 * 关键陷阱（本文件曾因此 9/10 假死 20 秒）：绝不能把 OCR promise 从 async
 * 辅助函数 return 出来再由用例 await——await 会递归同化内层 thenable，等于
 * 直接等 OCR 本身结束，喂页/abort 代码永远执行不到。
 */
function startOcr(filePath: string, signal?: AbortSignal): { promise: Promise<string>; child: FakeChild } {
  const promise = ocrPdfFile(filePath, signal)
  const child = children[children.length - 1]
  expect(child).toBeDefined()
  return { promise, child }
}

/** 派发若干页 + done 的便捷序列。 */
function feedPages(child: FakeChild, pages: string[], totalPages: number): void {
  pages.forEach((text, index) => {
    emit(child, { type: 'page', page: index + 1, totalPages, text })
  })
  emit(child, { type: 'done', pagesDone: pages.length, totalPages })
}

describe('ocrPdfFile（utilityProcess 编排）', () => {
  beforeEach(() => {
    children.length = 0
    installFork()
  })

  it('happy path：页文本按序拼接，结束即 kill', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    // 无页数预算（用户 2026-09-22 第二轮裁决：停止线全删）——job 不带 maxPages。
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ pdfPath: 'C:/books/a.pdf', scale: 3 }))
    expect(child.postMessage).toHaveBeenCalledWith(expect.not.objectContaining({ maxPages: expect.anything() }))
    // stdio 'pipe'（2026-09-22 验收事故长期改进）：worker stderr 必须收进主进程
    // 日志——默认 inherit 在安装版里等于丢弃崩溃栈。
    expect(vi.mocked(utilityProcess.fork)).toHaveBeenCalledWith(
      expect.stringContaining('ocrWorker.js'),
      [],
      expect.objectContaining({ serviceName: 'localOcrWorker', stdio: 'pipe' })
    )
    feedPages(child, ['第一页', '第二页'], 2)
    await expect(promise).resolves.toBe('第一页\n\n第二页')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('整本跑完：done(pagesDone=totalPages) 无截断说明（大书也全量）', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    feedPages(child, ['首页文本'], 1)
    await expect(promise).resolves.toBe('首页文本')
  })

  it('abort：立即拒绝并终止子进程', async () => {
    const controller = new AbortController()
    const { promise, child } = startOcr('C:/books/a.pdf', controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('子进程报 error 消息：如实上抛', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    emit(child, { type: 'error', message: '模型加载失败' })
    await expect(promise).rejects.toThrow('模型加载失败')
  })

  it('子进程意外退出：报错而非悬挂', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    ;(child as unknown as { emit: (event: string, code: number) => void }).emit('exit', 1)
    await expect(promise).rejects.toThrow('exited unexpectedly')
  })

  it('worker stdout/stderr 有流时接日志，无流（FakeChild）不炸', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    feedPages(child, ['页'], 1)
    await expect(promise).resolves.toBe('页')
  })

  it('模型未下载：不起子进程直接报可行动错误', async () => {
    const ocrPaths = await import('@main/services/localModel/ocrPaths')
    vi.mocked(ocrPaths.isLocalOcrModelDownloaded).mockReturnValueOnce(false)
    await expect(ocrPdfFile('C:/books/a.pdf')).rejects.toThrow('model is not downloaded')
    expect(children).toHaveLength(0)
  })
})

describe('terminateActiveOcrProcess（模型删除前置）', () => {
  beforeEach(() => {
    children.length = 0
    installFork()
  })

  it('有活进程：先 kill，等真正退出才返回；被终止的 OCR 调用侧如实报错不悬挂', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    void promise.catch(() => undefined) // terminate 触发的 exit 会让该 promise 拒绝；不悬空
    let returned = false
    const terminatePromise = terminateActiveOcrProcess().then(() => {
      returned = true
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(returned).toBe(false) // 未收到 exit 事件前不返回（Windows 句柄未释放）
    ;(child as unknown as { emit: (event: string, code: number) => void }).emit('exit', 0)
    await terminatePromise
    await expect(promise).rejects.toThrow('exited unexpectedly')
  })

  it('无活进程：直接返回，无 kill', async () => {
    await terminateActiveOcrProcess()
    expect(children).toHaveLength(0)
  })
})

describe('disposeOcrServiceThen（模型删除流前置）', () => {
  beforeEach(() => {
    children.length = 0
    installFork()
  })

  it('fn 在子进程退出之后才执行（Windows 句柄未释放前 unlink 会失败）', async () => {
    const { promise, child } = startOcr('C:/books/a.pdf')
    void promise.catch(() => undefined)
    let fnRan = false
    const disposePromise = disposeOcrServiceThen(async () => {
      fnRan = true
      return 'done'
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(fnRan).toBe(false) // kill 已发出但进程未退出：fn 不得提前跑
    ;(child as unknown as { emit: (event: string, code: number) => void }).emit('exit', 0)
    await expect(disposePromise).resolves.toBe('done')
    expect(fnRan).toBe(true)
  })
})
