/**
 * 作曲条工具栏的溢出图标态契约测试。
 *
 * 行为级验证（§4.18）：V2 `variants/shared/ComposerControlScaffolding.tsx:53-54` 用
 * `useOverflowIconOnly` 量宽度，溢出时把上下文控件切成图标态（`w-8 justify-center px-0` +
 * `sr-only` 文字）。fork 此前 `iconOnly` 恒 false —— 窄窗下工具栏控件被 `overflow-hidden` 裁掉（P1）。
 */
import { cn } from '@renderer/utils/style'
import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMPOSER_ICON_ONLY_LABEL_CLASS,
  COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS,
  COMPOSER_SELECTOR_BUTTON_CLASS,
  ComposerToolbarControls
} from '../ComposerControlScaffolding'

type ObserverCallback = (entries: Array<{ target: Element; contentRect: { width: number } }>) => void

const observers: Array<{ callback: ObserverCallback; target: Element }> = []

class FakeResizeObserver {
  private callback: ObserverCallback

  constructor(callback: ObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    observers.push({ callback: this.callback, target })
  }

  unobserve() {}
  disconnect() {}
}

const setWidth = (element: Element, clientWidth: number, scrollWidth: number) => {
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true })
}

const flushOverflow = (element: Element, clientWidth: number, scrollWidth: number) => {
  setWidth(element, clientWidth, scrollWidth)
  const observer = observers.findLast((entry) => entry.target === element)
  if (!observer) throw new Error('toolbar container was not observed')
  // ResizeObserver 回调在真实浏览器里是异步投递的，React 18+ 的自动批处理会把它当"外部事件"，
  // 故测试里必须显式 act() 收口这次测量引发的 setState。
  act(() => {
    observer.callback([{ target: element, contentRect: { width: clientWidth } }])
  })
}

/** variant 侧控件替身：完全按 V2 的 `iconOnly` 分流写 class（与 PaintingComposer 同形态）。 */
const ContextControls = ({ iconOnly }: { iconOnly: boolean }) => (
  <button
    type="button"
    data-testid="context-control"
    className={cn(COMPOSER_SELECTOR_BUTTON_CLASS, iconOnly && COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS)}>
    <span className={iconOnly ? COMPOSER_ICON_ONLY_LABEL_CLASS : undefined}>model</span>
  </button>
)

const renderToolbar = () =>
  render(
    <ComposerToolbarControls
      renderContextControls={({ iconOnly }: { iconOnly: boolean }) => <ContextControls iconOnly={iconOnly} />}
    />
  )

describe('ComposerToolbarControls · 溢出切图标态', () => {
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  it('未溢出时保持全宽（现状不变）', () => {
    renderToolbar()
    const control = screen.getByTestId('context-control')
    expect(control.className).not.toContain('w-8')
    expect(control.querySelector('span')?.className ?? '').not.toContain('sr-only')
  })

  it('量到溢出后切图标态：宽度收到 32px、文字转屏读专用', () => {
    renderToolbar()
    const container = screen.getByTestId('context-control').parentElement as HTMLElement

    flushOverflow(container, 100, 260)

    const control = screen.getByTestId('context-control')
    expect(control.className).toContain(COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS)
    expect(control.querySelector('span')?.className).toContain(COMPOSER_ICON_ONLY_LABEL_CLASS)
  })

  it('宽度恢复后退出图标态（不残留），且临界缓冲内保持不抖动', () => {
    renderToolbar()
    const container = screen.getByTestId('context-control').parentElement as HTMLElement

    flushOverflow(container, 100, 260)
    expect(screen.getByTestId('context-control').className).toContain(COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS)

    // 只放回 20px（在 24px 释放缓冲内）→ 仍保持图标态。
    flushOverflow(container, 120, 120)
    expect(screen.getByTestId('context-control').className).toContain(COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS)

    // 放回足够宽（超出缓冲）→ 回到全宽。
    flushOverflow(container, 260, 260)
    expect(screen.getByTestId('context-control').className).not.toContain(COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS)
  })
})
