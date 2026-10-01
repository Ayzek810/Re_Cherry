/**
 * `handleChunkSizeChange` 必须把「嵌入模型上下文上限查不到」（`null`）
 * 与「不适用 → 无上限」分开。
 *
 * 背景（的消费侧）：`getEmbeddingMaxContext` 的三值契约是「数值 = 确定上限 /
 * `null` = 没有答案」。旧实现把两者都喂给 `if (!value || !maxContext || value <= maxContext)`，
 * 于是 `null`（提供方没给出答案）与 `undefined`（真的不适用）同形：都静默放过任意 chunkSize
 * —— 失败长得像通过。
 *
 * 本文件用替身把两种返回值分别喂进去，钉住两条相反的行为。同一个替身实例贯穿全文件，
 * 因此「null 弹了 1 次、undefined 弹了 0 次」是同一观察窗里的直接对照。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MODEL, getEmbeddingMaxContextMock, toastMocks, nextMaxContext } = vi.hoisted(() => ({
  MODEL: { id: 'm1', name: 'M1', provider: 'p1' },
  getEmbeddingMaxContextMock: vi.fn(),
  toastMocks: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
  nextMaxContext: { value: null as number | null | undefined }
}))

vi.mock('react-i18next', () => ({
  // 透传 key 与插值参数：断言要能看到 `{ limit }`（只回 key 会丢掉第二参会话）。
  useTranslation: () => ({ t: (key: string, options?: unknown) => (options === undefined ? key : [key, options]) })
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: [{ id: 'p1', models: [MODEL] }] })
}))
vi.mock('@renderer/hooks/usePreprocess', () => ({ usePreprocessProviders: () => ({ preprocessProviders: [] }) }))
vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (m?: { id?: string }) => (m?.id ? `uid:${m.id}` : '')
}))
vi.mock('@renderer/config/embedings', () => ({
  getEmbeddingMaxContext: getEmbeddingMaxContextMock
}))

import { useKnowledgeBaseForm } from '../useKnowledgeBaseForm'

/** 一次性渲染：选好模型，并把上限替身固定为给定值。 */
const renderWith = (maxContext: number | null) => {
  nextMaxContext.value = maxContext
  const { result } = renderHook(() => useKnowledgeBaseForm())
  act(() => result.current.handlers.handleEmbeddingModelChange('uid:m1'))
  return result
}

const warningCalls = () => toastMocks.warning.mock.calls.length

describe('useKnowledgeBaseForm.handleChunkSizeChange（⑬：null ≠ 无上限）', () => {
  beforeEach(() => {
    getEmbeddingMaxContextMock.mockReset()
    // 替身不返回值 = 返回 undefined：类型声明是 `number | null`，这一支模拟"调用方拿不到答案"，
    // 现存实现的 `!maxContext` 分支正是为它保留的（undefined = 稍后重试/不适用）。
    getEmbeddingMaxContextMock.mockImplementation(() => nextMaxContext.value)
    toastMocks.error.mockReset()
    toastMocks.warning.mockReset()
    ;(window as unknown as { toast: unknown }).toast = toastMocks
  })

  it('maxContext === null（提供方没有答案）→ 用户可见 warning；数值仍接受，但不是静默通过', () => {
    const result = renderWith(null)

    act(() => result.current.handlers.handleChunkSizeChange(99999))

    expect(toastMocks.warning).toHaveBeenCalledWith('message.error.chunk_size_unknown_limit')
    expect(result.current.newBase.chunkSize).toBe(99999)
  })

  it('maxContext === undefined（真的不适用）→ 沿用原有"无上限"路径：零提示', () => {
    const result = renderWith(undefined as unknown as null)
    const before = warningCalls()

    act(() => result.current.handlers.handleChunkSizeChange(99999))

    expect(warningCalls()).toBe(before)
    expect(toastMocks.error).not.toHaveBeenCalled()
    expect(result.current.newBase.chunkSize).toBe(99999)
  })

  it('null 与 undefined 的行为不同（判别式对照：同一输入值 500，一个有提示一个没有）', () => {
    const nullRun = renderWith(null)
    const beforeNull = warningCalls()
    act(() => nullRun.current.handlers.handleChunkSizeChange(500))
    const nullWarnings = warningCalls() - beforeNull
    const nullAccepted = nullRun.current.newBase.chunkSize

    const undefinedRun = renderWith(undefined as unknown as null)
    const beforeUndefined = warningCalls()
    act(() => undefinedRun.current.handlers.handleChunkSizeChange(500))
    const undefinedWarnings = warningCalls() - beforeUndefined
    const undefinedAccepted = undefinedRun.current.newBase.chunkSize

    expect(nullWarnings).toBe(1)
    expect(undefinedWarnings).toBe(0)
    // 两条路径都不阻断用户输入（未知上限不冒充"有上限"），区别只在**是否给出可见信号**。
    expect(nullAccepted).toBe(500)
    expect(undefinedAccepted).toBe(500)
  })

  it('有确定上限且超限 → error（与原行为一致）；未超限 → 静默接受', () => {
    const result = renderWith(1024)
    const before = warningCalls()

    act(() => result.current.handlers.handleChunkSizeChange(2048))
    expect(toastMocks.error).toHaveBeenCalledWith(['message.error.chunk_size_too_large', { limit: 1024 }])
    expect(result.current.newBase.chunkSize).toBeUndefined()

    act(() => result.current.handlers.handleChunkSizeChange(512))
    expect(result.current.newBase.chunkSize).toBe(512)
    expect(warningCalls()).toBe(before)
  })

  it('未选模型时不做校验（没有模型就没有可查的上限）', () => {
    nextMaxContext.value = null
    const { result } = renderHook(() => useKnowledgeBaseForm())
    const before = warningCalls()

    act(() => result.current.handlers.handleChunkSizeChange(4096))

    expect(getEmbeddingMaxContextMock).not.toHaveBeenCalled()
    expect(warningCalls()).toBe(before)
  })
})
