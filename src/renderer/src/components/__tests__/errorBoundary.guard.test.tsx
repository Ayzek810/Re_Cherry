/**
 * v0.3.1-2：白屏护栏行为测试。
 *
 * 事故背景：渲染期抛错（hook 契约违规 / 持久化形态不匹配等）此前表现为**整窗白屏且零线索**，
 * 只能靠人工猜。本测试证明两道护栏真的生效：
 * ① 顶层 ErrorBoundary 捕获渲染错误并显示错误文本；
 * ② 重放期不再渲染空白（`PersistGate loading={null}`），而是可见占位。
 *
 * 反证（§4.3）：每道护栏都配一条"去掉护栏即变红"的对照，避免假绿。
 */
import PersistLoadingFallback from '@renderer/components/PersistLoadingFallback'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { render, screen } from '@testing-library/react'
import type { FC } from 'react'
import { PersistGate } from 'redux-persist/integration/react'
import type { Persistor } from 'redux-persist'
import { describe, expect, it, vi } from 'vitest'

import '@renderer/i18n'

const Boom: FC = () => {
  throw new Error('BOOM_MARKER')
}

/** 永不 bootstrapped 的 persistor：让 PersistGate 停在 loading 态。 */
const pendingPersistor = {
  getState: () => ({ bootstrapped: false, registry: [] }),
  subscribe: () => () => {}
} as unknown as Persistor

describe('顶层错误边界', () => {
  it('反证：不套边界时抛错会向上冒（说明错误真实存在）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Boom />)).toThrow(/BOOM_MARKER/)
    spy.mockRestore()
  })

  it('套上边界后捕获错误并显示错误文本（不再白屏零线索）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    // 回退 UI 里会展示 formatErrorMessage(error)，即错误原文
    expect(screen.getByText(/BOOM_MARKER/)).toBeInTheDocument()
    spy.mockRestore()
  })
})

describe('PersistGate 重放期占位', () => {
  it('反证：loading={null} 时重放期渲染为空（即旧行为就是白屏）', () => {
    const { container } = render(
      <PersistGate loading={null} persistor={pendingPersistor}>
        <div>content</div>
      </PersistGate>
    )
    expect((container.textContent ?? '').trim()).toBe('')
  })

  it('换上可见占位后，重放期不再是空白', () => {
    render(
      <PersistGate loading={<PersistLoadingFallback />} persistor={pendingPersistor}>
        <div>content</div>
      </PersistGate>
    )
    expect(screen.getByText('正在恢复本地数据…')).toBeInTheDocument()
  })
})