/**
 * c2-16 行为测试：隐私政策弹窗的加载中与失败态。
 *
 * 原状：`privacyUrl` 就绪前 body 是空框；`runAsyncFunction` 不 catch，`getAppInfo()` 一旦 reject
 * 就**永久**空白。两种情况下「我已知晓」都可点并写入 `privacy-popup-accepted` ——
 * 用户在一个从未看到内容的政策弹窗上完成「接受」。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PrivacyPopupContainer } from '../PrivacyPopup'

const mocks = vi.hoisted(() => ({ getAppInfo: vi.fn(), quit: vi.fn() }))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', settedTheme: 'light', toggleTheme: vi.fn() })
}))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show: vi.fn(), hide: vi.fn() } }))

vi.mock('antd', () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <div data-testid="modal">
      {children}
      <div data-testid="footer">{footer}</div>
    </div>
  ),
  Button: ({ children, ...rest }: { children?: ReactNode }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  Spin: () => <div data-testid="spin" />,
  Typography: { Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }) }
})

describe('PrivacyPopup content gate (c2-16)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    ;(window as unknown as { api: unknown }).api = {
      getAppInfo: mocks.getAppInfo,
      quit: mocks.quit
    }
  })

  it('keeps Accept disabled and shows an error with retry when the URL cannot be resolved', async () => {
    mocks.getAppInfo.mockRejectedValue(new Error('no app info'))

    render(<PrivacyPopupContainer resolve={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('privacy-popup-status')).toBeInTheDocument())
    expect(screen.getByTestId('privacy-popup-retry')).toBeInTheDocument()

    const accept = screen.getByText('common.i_know')
    expect(accept).toBeDisabled()

    // 点「我已知晓」不得在被禁用的按钮上产生接受记录。
    fireEvent.click(accept)
    expect(localStorage.getItem('privacy-popup-accepted')).toBeNull()
  })

  it('enables Accept only after the webview reports did-finish-load', async () => {
    mocks.getAppInfo.mockResolvedValue({ appPath: '/app' })

    const { container } = render(<PrivacyPopupContainer resolve={vi.fn()} />)

    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())

    const accept = screen.getByText('common.i_know')
    // 正文还没加载完 —— 依旧是加载态，接受仍然不可点。
    expect(accept).toBeDisabled()
    expect(screen.getByTestId('spin')).toBeInTheDocument()

    fireEvent(container.querySelector('webview') as Element, new Event('did-finish-load'))

    await waitFor(() => expect(screen.getByText('common.i_know')).toBeEnabled())
    expect(screen.queryByTestId('spin')).not.toBeInTheDocument()
  })
})
