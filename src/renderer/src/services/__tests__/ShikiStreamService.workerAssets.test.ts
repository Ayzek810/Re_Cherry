/**
 * p2-04 行为测试：worker 侧语法/主题资产的**主线程应答端**。
 *
 * 背景（实测）：worker 曾是**一份独立的 rollup 模块图**，它自己 `import('shiki')` 会再编译一份
 * `bundledLanguages` 语言表 ⇒ 产物里每个语法两份，重复 4.15 MB。修法是把 worker 图里的语言表
 * 彻底删掉：worker 只保留 `shiki/core` + js 引擎，语法/主题的注册数据经 `postMessage`
 * 向主线程索取。
 *
 * 本测试锁定主线程这一端的三条不变量（worker 端 `requestAsset` 只在浏览器 Worker 里跑，
 * 由构建产物的 chunk 面验证）：
 *  1. `language` / `theme` 请求能拿到**非空注册数据**（数据可结构化克隆）；
 *  2. 未知语言/主题回**明确的 error**，而不是伪装成空结果（家规：失败不得看起来像空结果）；
 *  3. 资产请求不占用 `pendingRequests`，也不取消 worker 空闲回收计时。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { shikiStreamService } from '../ShikiStreamService'

interface PostedAssetResponse {
  id: number
  type: 'assets-result'
  result?: unknown[]
  error?: string
}

describe('ShikiStreamService worker asset protocol (p2-04)', () => {
  let posted: PostedAssetResponse[]

  beforeEach(() => {
    posted = []
    // 假 worker：只记录资产回包，不做任何高亮计算
    // @ts-ignore: access private
    shikiStreamService.worker = {
      postMessage: (message: PostedAssetResponse) => {
        if (message.type === 'assets-result') posted.push(message)
      },
      terminate: () => {}
    } as any
  })

  afterEach(() => {
    shikiStreamService.dispose()
    vi.restoreAllMocks()
  })

  const handle = (id: number, kind: unknown, name: unknown): Promise<void> =>
    // @ts-ignore: access private
    shikiStreamService.handleWorkerAssetRequest(id, kind, name)

  it('answers a language request with real registration data', async () => {
    await handle(0xa55e0001, 'language', 'typescript')

    expect(posted).toHaveLength(1)
    expect(posted[0].id).toBe(0xa55e0001)
    expect(posted[0].error).toBeUndefined()
    const registrations = posted[0].result as Array<Record<string, unknown>>
    expect(Array.isArray(registrations)).toBe(true)
    expect(registrations.length).toBeGreaterThan(0)
    // 语言注册数据必须带 name + scopeName（shiki 的 TextMate 语法契约）
    expect(typeof registrations[0].name).toBe('string')
    expect(typeof registrations[0].scopeName).toBe('string')
    // 可结构化克隆（否则 postMessage 到 worker 会抛 DataCloneError）
    expect(() => structuredClone(registrations)).not.toThrow()
  })

  it('answers a theme request with registration data carrying a name', async () => {
    await handle(0xa55e0002, 'theme', 'one-light')

    expect(posted).toHaveLength(1)
    const registrations = posted[0].result as Array<Record<string, unknown>>
    expect(registrations.length).toBeGreaterThan(0)
    expect(registrations[0].name).toBe('one-light')
    expect(() => structuredClone(registrations)).not.toThrow()
  })

  it('reports an explicit error for an unknown language instead of an empty result', async () => {
    await handle(0xa55e0003, 'language', 'definitely-not-a-language')

    expect(posted).toHaveLength(1)
    expect(posted[0].result).toBeUndefined()
    expect(posted[0].error).toContain('definitely-not-a-language')
  })

  it('reports an explicit error for an unknown asset kind and for an empty name', async () => {
    await handle(0xa55e0004, 'grammar', 'typescript')
    await handle(0xa55e0005, 'language', '')

    expect(posted.map((p) => p.error !== undefined)).toEqual([true, true])
  })

  it('does not touch pendingRequests and keeps the idle-recycle timer alive', async () => {
    // @ts-ignore: access private
    const cancelSpy = vi.spyOn(shikiStreamService as any, 'cancelWorkerIdleTerminate')
    // @ts-ignore: access private
    shikiStreamService.pendingRequests.set(42, { resolve: () => {}, reject: () => {} })

    await handle(0xa55e0006, 'language', 'json')

    // @ts-ignore: access private
    expect(shikiStreamService.pendingRequests.has(42)).toBe(true)
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(posted).toHaveLength(1)
  })

  it('survives a worker that is gone by the time the answer is posted', async () => {
    // @ts-ignore: access private
    shikiStreamService.worker = {
      postMessage: () => {
        throw new Error('worker terminated')
      },
      terminate: () => {}
    } as any

    await expect(handle(0xa55e0007, 'language', 'json')).resolves.toBeUndefined()
  })
})
