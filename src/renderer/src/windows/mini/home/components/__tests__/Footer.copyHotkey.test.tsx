/**
 * Footer 复制热键的路由门控：翻译路由的 C 由 TranslateWindow 自己接管（它持有译文），
 * 否则一次按键会写两遍剪贴板并弹两个成功提示。本测试钉住这条门控。
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import Footer from '../Footer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const renderFooter = (route: string, onCopy: () => void) =>
  render(<Footer route={route} setIsPinned={() => {}} isPinned={false} onEsc={() => {}} onCopy={onCopy} />)

describe('Footer · 复制热键按路由门控', () => {
  it('非翻译路由：按 C 交给 Footer 的 onCopy', () => {
    const onCopy = vi.fn()
    renderFooter('chat', onCopy)

    fireEvent.keyDown(document, { key: 'c' })

    expect(onCopy).toHaveBeenCalledTimes(1)
  })

  it('翻译路由：Footer 不接管 C，交给 TranslateWindow', () => {
    const onCopy = vi.fn()
    renderFooter('translate', onCopy)

    fireEvent.keyDown(document, { key: 'c' })

    expect(onCopy).not.toHaveBeenCalled()
  })
})
