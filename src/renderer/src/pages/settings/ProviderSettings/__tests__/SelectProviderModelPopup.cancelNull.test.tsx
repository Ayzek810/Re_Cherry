import '@renderer/i18n'

import type { Model, Provider } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 模型选择弹窗的取消语义（v1 二轮审查 s2-08 / s2-43）。
 *
 * 旧实现 `onCancel` 里排了一个 300ms 的 `reject`，而 `useTimer` 在卸载时会 `clearAllTimers()`：
 * 弹窗关闭即卸载 → 定时器被清 → 外层 `await SelectProviderModelPopup.show(...)` 永不 settle
 *（`onCheckApi` 之后一行都不执行）；若 300ms 内没卸载，`reject()` 又因调用点在 try 之外而
 * 无人接收。下面锁住「取消 = resolve(null) 哨兵，且立即 settle」。
 */

const topViewMock = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }))

vi.mock('@renderer/components/TopView', () => ({ TopView: topViewMock }))
vi.mock('@renderer/components/ModelSelector', () => ({ default: () => <div data-testid="model-selector" /> }))

import SelectProviderModelPopup from '../SelectProviderModelPopup'

const model = { id: 'm1', name: 'Model One', provider: 'p1' } as unknown as Model
const provider = { id: 'p1', name: 'Provider', models: [model] } as unknown as Provider

/** `show()` 把元素交给 TopView.show —— 取回它自己渲染（等价于 TopView 的挂载）。 */
const showAndRender = () => {
  const promise = SelectProviderModelPopup.show({ provider })
  const element = topViewMock.show.mock.calls.at(-1)?.[0] as React.ReactElement
  render(element)
  return promise
}

beforeEach(() => {
  topViewMock.show.mockClear()
  topViewMock.hide.mockClear()
})

describe('SelectProviderModelPopup 的取消与确认', () => {
  it('点取消后 Promise 立即以 null 结束（旧实现永不 settle 或产生无人接收的 rejection）', async () => {
    const promise = showAndRender()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    await expect(promise).resolves.toBeNull()
  })

  it('点确认 resolve 选中的模型', async () => {
    const promise = showAndRender()

    fireEvent.click(document.querySelector('.ant-btn-primary') as HTMLButtonElement)

    await expect(promise).resolves.toMatchObject({ id: 'm1' })
  })
})
