/**
 * `EditKnowledgeBasePopup` 在 render 阶段调用 `resolve()`。
 *
 * 缺陷形态：`if (!base) { resolve(null); return null }` 写在组件渲染体内，而 `show()` 传入的
 * `resolve` 包装先 `this.hide()`（TopView 容器 setState）再 `resolve(v)`。等于在一个组件渲染期间
 * 更新另一个组件——React 报 "Cannot update a component while rendering a different component"，
 * 并发/StrictMode 下同一副作用还可能重复执行（重复 hide/resolve）。
 *
 * 行为级断言：`base` 缺省时 ① 该帧只渲染 `null`；② 渲染过程本身不产生 React 的跨组件渲染期
 * 更新告警；③ `resolve(null)` 在 effect 里落地且恰好一次（`show()` 的 Promise resolve 成 null）。
 */
import type { KnowledgeBase } from '@renderer/types'
import { render, waitFor } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

const { useKnowledgeMock, showMock } = vi.hoisted(() => ({
  useKnowledgeMock: vi.fn(),
  showMock: vi.fn()
}))

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@reduxjs/toolkit', () => ({ nanoid: () => 'nano-1' }))

vi.mock('@renderer/hooks/useKnowledge', () => ({
  useKnowledge: () => useKnowledgeMock()
}))

vi.mock('@renderer/hooks/useKnowledgeBaseForm', () => ({
  useKnowledgeBaseForm: () => ({
    newBase: { id: 'base-1', model: { id: 'm', name: 'M' }, dimensions: 1 },
    setNewBase: vi.fn(),
    handlers: {},
    providerData: { selectedDocPreprocessProvider: undefined, docPreprocessSelectOptions: [] }
  })
}))

vi.mock('@renderer/services/ModelService', () => ({ getModelUniqId: () => '' }))

vi.mock('../KnowledgeSettings', () => ({
  KnowledgeBaseFormModal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  GeneralSettingsPanel: () => <div />,
  AdvancedSettingsPanel: () => <div />
}))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show: showMock, hide: vi.fn() } }))

import EditKnowledgeBasePopup from '../EditKnowledgeBasePopup'

const anyBase = { id: 'base-1', name: 'Demo' } as KnowledgeBase

describe('EditKnowledgeBasePopup render 期副作用', () => {
  it('base 缺省：只渲染 null、无渲染期跨组件更新告警、resolve(null) 恰好一次', async () => {
    useKnowledgeMock.mockReturnValue({ base: undefined, updateKnowledgeBase: vi.fn(), migrateBase: vi.fn() })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    showMock.mockClear()

    const settled = EditKnowledgeBasePopup.show({ base: anyBase })
    const element = showMock.mock.calls[0][0] as React.ReactElement
    const { container } = render(element)

    // ① 该帧没有任何可见内容。
    expect(container.textContent).toBe('')
    // ② 渲染期没有 React 的跨组件更新告警。
    const warnings = consoleError.mock.calls.map((call) => String(call[0]))
    expect(warnings.filter((text) => text.includes('while rendering a different component'))).toEqual([])

    // ③ 副作用在 effect 里结算，Promise 以 null 收口。
    await expect(settled).resolves.toBeNull()
    await waitFor(() => {
      expect(container.textContent).toBe('')
    })

    consoleError.mockRestore()
  })
})
