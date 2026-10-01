/**
 * 翻译自定义指令只在 `onBlur` 落库。
 *
 * 缺陷形态：`savePrompt` 只挂在 `Input.TextArea` 的 `onBlur` 上，而抽屉是 antd `Drawer`
 * （默认 `destroyOnClose=false`）——Esc / 点遮罩关闭时子节点不卸载，`blur` 不会触发。结果是：
 * 设置未保存，但 `promptDraft` 仍在，再次打开抽屉时文本框显示的是**未生效的草稿**，
 * 界面与 redux 真实值不一致，用户以为已经保存。
 *
 * 行为级断言：改完指令后走 Drawer 的关闭路径（Esc/遮罩/关闭按钮在 antd 里是同一个 `onClose`），
 * ① 草稿被提交进 redux（`settings.translateCustomPrompt`）；② 草稿被清空，控件值回到 redux 真实值。
 */
import store from '@renderer/store'
import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { drawerOnClose } = vi.hoisted(() => ({
  drawerOnClose: { current: undefined as undefined | (() => void) }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined }
}))

// Drawer 替身：把 `onClose` 暴露出来（Esc / 遮罩 / 关闭按钮在 antd 里都是这一个回调）。
vi.mock('antd', () => ({
  Drawer: ({ onClose, children }: { onClose?: () => void; children?: React.ReactNode }) => {
    drawerOnClose.current = onClose
    return <div data-testid="drawer">{children}</div>
  },
  Switch: () => <button type="button" />,
  Select: () => <select />,
  Button: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
  Input: {
    TextArea: ({ value, onChange }: { value?: string; onChange?: (event: { target: { value: string } }) => void }) => (
      <textarea
        data-testid="prompt"
        value={value}
        onChange={(event) => onChange?.({ target: { value: event.target.value } })}
      />
    )
  }
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({ default: () => <span /> }))

import TranslateSettings from '../TranslateSettings'

describe('TranslateSettings 关闭抽屉时提交指令', () => {
  beforeEach(() => {
    drawerOnClose.current = undefined
    // 基线：库里没有自定义指令（= 用内置）。
    store.dispatch({ type: 'settings/setTranslatePreferences', payload: { translateCustomPrompt: '' } })
  })

  it('关闭抽屉提交草稿，并把控件值还原成 redux 真实值', () => {
    render(
      <Provider store={store}>
        <TranslateSettings visible model={undefined} onClose={vi.fn()} onSelectModel={vi.fn()} />
      </Provider>
    )

    // 编辑（只进草稿，不落库）。
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'my custom prompt' } })
    expect(store.getState().settings.translateCustomPrompt).toBe('')
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-testid="prompt"]')?.value).toBe(
      'my custom prompt'
    )

    // 关闭抽屉（Esc/遮罩同路径）：旧实现在这里什么都不做，草稿留在界面上且没保存。
    drawerOnClose.current?.()

    // ① 草稿提交进 redux。
    expect(store.getState().settings.translateCustomPrompt).toBe('my custom prompt')

    // ② 草稿被清空：重新挂载抽屉时控件显示 redux 真实值，而不是残留的未生效草稿。
    const reopened = render(
      <Provider store={store}>
        <TranslateSettings visible model={undefined} onClose={vi.fn()} onSelectModel={vi.fn()} />
      </Provider>
    )
    expect((reopened.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('my custom prompt')
  })
})
