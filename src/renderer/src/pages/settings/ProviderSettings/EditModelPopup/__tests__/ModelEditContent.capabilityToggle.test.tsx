import '@renderer/i18n'

import type { Model, Provider } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 能力标签的开关方向。
 *
 * 审计判断：`updateType` 的空依赖闭包永远用首帧那份 `selectedTypes`，于是第二次点击方向会错。
 * 复核结论（NOT-A-PROBLEM）：`ModelCapability` 定义在 `ModelEditContent` 的渲染体内，每次父渲染
 * 都是**新的组件类型** → React 卸载重挂 → `useCallback` 回调随重挂重建，闭包用的是当次渲染的
 * `selectedTypes`。这条用例连「空依赖」的原实现一起验证过：点两次方向确实翻转。
 * 保留用例的价值在于：谁把 `ModelCapability` 提到渲染体外（那时空依赖才会真的僵住），
 * 这里会立刻变红。
 */

const mocks = vi.hoisted(() => ({ onUpdateModel: vi.fn() }))

vi.mock('@renderer/hooks/useDynamicLabelWidth', () => ({ useDynamicLabelWidth: (v: unknown) => v }))

import ModelEditContent from '../ModelEditContent'

const provider = { id: 'p1', name: 'P', models: [] } as unknown as Provider
const model = { id: 'm1', name: 'Model', capabilities: [] } as unknown as Model

/** 最近一次 autoSave 写回的 capabilities。 */
const lastCapabilities = () => {
  const calls = mocks.onUpdateModel.mock.calls
  return (calls.at(-1)?.[0] as Model | undefined)?.capabilities
}

beforeEach(() => {
  mocks.onUpdateModel.mockReset()
})

beforeAll(() => {
  // antd Modal / InputNumber 依赖 matchMedia（jsdom 未内置）
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

describe('模型能力标签的切换方向', () => {
  it('同一标签点两次：第一次选中、第二次取消（方向不依据首帧集合）', () => {
    render(<ModelEditContent provider={provider} model={model} onUpdateModel={mocks.onUpdateModel} open />)

    // 展开「更多设置」才会渲染能力标签
    fireEvent.click(screen.getByRole('button', { name: /更多设置|More Settings/i }))

    // 每次点击都重新取节点：`ModelCapability` 每次父渲染都是新的组件类型（见用例头注释），
    // 旧节点会被卸载，持有它会点空。
    fireEvent.click(screen.getByText(/^(视觉|Vision)$/))
    expect(lastCapabilities()).toEqual([{ type: 'vision', isUserSelected: true }])

    fireEvent.click(screen.getByText(/^(视觉|Vision)$/))
    expect(lastCapabilities()).toEqual([{ type: 'vision', isUserSelected: false }])
  })
})
