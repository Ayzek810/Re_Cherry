/**
 * Onboarding 隐私同意勾选框默认已选，且挂载即强制写入"已同意"。
 *
 * 证据形态：`useState(true)` + `useEffect(() => updateDataCollection(true), [...])` —— 只要页面挂载
 * （含"跳过"路径），`enableDataCollection=true` 就被写进 redux 与 `config`，把用户此前持久化的拒绝
 * 覆盖掉；而 `config.set` 是 fire-and-forget，写盘失败没有任何信号。
 *
 * 行为级断言：
 *   ① 持久化值为 false 时，勾选框初始未选中，且挂载**不**写 config；
 *   ② 勾选后 redux 与 config 一起变为 true；
 *   ③ config 写入失败 → `toast.error` 有信号。
 */
import '@renderer/i18n'

import store from '@renderer/store'
import { setEnableDataCollection } from '@renderer/store/settings'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configSet = vi.fn()
const toastError = vi.fn()

vi.mock('@renderer/components/WindowControls', () => ({ default: () => <div /> }))
vi.mock('@renderer/components/Popups/PrivacyPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('../components/WelcomePage', () => ({ default: () => <div data-testid="welcome" /> }))
vi.mock('../components/SelectModelPage', () => ({ default: () => <div data-testid="select-model" /> }))
vi.mock('../components/SkipButton', () => ({ default: () => <div data-testid="skip" /> }))

import OnboardingPage from '../OnboardingPage'

function renderPage() {
  return render(
    <Provider store={store}>
      <OnboardingPage onComplete={vi.fn()} />
    </Provider>
  )
}

function checkbox() {
  return screen.getByRole('checkbox')
}

describe('Onboarding 隐私同意', () => {
  beforeEach(() => {
    configSet.mockReset()
    configSet.mockResolvedValue(undefined)
    toastError.mockReset()
    ;(window as unknown as { api: unknown }).api = { config: { set: configSet } }
    ;(window as unknown as { toast: unknown }).toast = {
      error: toastError,
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    }
  })

  it('已持久化的拒绝不会被挂载覆盖：初始未勾选、且挂载不写 config', () => {
    store.dispatch(setEnableDataCollection(false))

    renderPage()

    expect(checkbox()).not.toBeChecked()
    // 旧实现的挂载 effect 会在这里写一次 true —— 用户的拒绝不具持久性。
    expect(configSet).not.toHaveBeenCalled()
  })

  it('已持久化的同意会反映到勾选框，同样不产生额外写入', () => {
    store.dispatch(setEnableDataCollection(true))

    renderPage()

    expect(checkbox()).toBeChecked()
    expect(configSet).not.toHaveBeenCalled()
  })

  it('用户勾选后才落盘，且 redux 与 config 一起变', async () => {
    store.dispatch(setEnableDataCollection(false))
    renderPage()

    fireEvent.click(checkbox())

    expect(store.getState().settings.enableDataCollection).toBe(true)
    await waitFor(() => expect(configSet).toHaveBeenCalledWith('enableDataCollection', true))
  })

  it('落盘失败必须给出信号（fire-and-forget 也不得静默）', async () => {
    store.dispatch(setEnableDataCollection(false))
    configSet.mockRejectedValueOnce(new Error('disk full'))
    renderPage()

    fireEvent.click(checkbox())

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })
})
