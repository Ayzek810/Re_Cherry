/**
 * `useKnowledgeBaseForm` 的「还没选模型」窗口是明确的未选择态。
 *
 * 改动前初值写 `model: null as any`（绕过类型系统），于是
 *  1. `KnowledgeBase.model` 的消费方在"未选择"期间拿到 `null`，而不是可判定的缺省；
 *  2. 提交路径的窄化不再被编译器强制。
 * 改动后表单态是 `KnowledgeBaseForm`（`model?: Model`），初值为 `undefined`。
 *
 * 断言：初值 `model === undefined`（不是 `null`）；选择模型后写入真实模型对象，
 * 提交路径（消费方）可用 `if (!newBase.model) return` 窄化。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { MODEL } = vi.hoisted(() => ({ MODEL: { id: 'm1', name: 'M1', provider: 'p1' } }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/hooks/useProvider', () => ({ useProviders: () => ({ providers: [{ id: 'p1', models: [MODEL] }] }) }))
vi.mock('@renderer/hooks/usePreprocess', () => ({ usePreprocessProviders: () => ({ preprocessProviders: [] }) }))
vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (m?: { id?: string }) => (m?.id ? `uid:${m.id}` : '')
}))

import { useKnowledgeBaseForm } from '../useKnowledgeBaseForm'

describe('useKnowledgeBaseForm ：未选择模型是明确的缺省', () => {
  it('初值的 model 是 undefined（不是 null，也无 as any）', () => {
    const { result } = renderHook(() => useKnowledgeBaseForm())

    expect(result.current.newBase.model).toBeUndefined()
    expect(result.current.newBase.name).toBe('')
    expect(result.current.newBase.items).toEqual([])
  })

  it('选择模型后表单态写入真实模型对象', () => {
    const { result } = renderHook(() => useKnowledgeBaseForm())

    act(() => result.current.handlers.handleEmbeddingModelChange('uid:m1'))

    expect(result.current.newBase.model).toEqual(MODEL)
  })
})
