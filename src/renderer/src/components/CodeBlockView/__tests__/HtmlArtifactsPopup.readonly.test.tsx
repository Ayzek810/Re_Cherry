/**
 * 产物弹窗必须沿用会话的只读契约，且保存勾要有真实依据。
 *
 * 缺陷原状：CodePanel 把 `editable` 写死为 true，于是调用方 fail-closed 传入的
 * `editable: false`（MessageHtmlArtifact 的默认值）在弹窗路径里被静默放宽成可改写；
 * 同一处 `handleSave` 无论 `save()` 是否存在都亮绿勾 —— 成功提示没有依据。
 */
import { HtmlArtifactPopupHost } from '@renderer/components/CodeBlockView/HtmlArtifactPopupContext'
import { MessageHtmlArtifact } from '@renderer/pages/home/Messages/Blocks/MessageHtmlArtifact'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 此处要钉的是弹窗把自己收到的 editable 透传给代码面板；CodeMirror 本体不是被测对象。
vi.mock('@renderer/components/CodeEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    default: forwardRef(
      (
        { value, editable, onSave }: { value: string; editable?: boolean; onSave?: (html: string) => void },
        ref: React.Ref<{ save?: () => void }>
      ) => {
        useImperativeHandle(ref, () => ({ save: onSave ? () => onSave(value) : undefined }), [onSave, value])
        return (
          <pre data-testid="artifact-code-editor" data-editable={String(editable)} contentEditable={editable}>
            {value}
          </pre>
        )
      }
    )
  }
})

vi.mock('@renderer/components/CodeViewer', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="artifact-code-view">{value}</pre>
}))

// 保留模块其余导出（i18n/index.ts 依赖 initReactI18next，整体替换会让测试文件加载失败）。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const openPopup = async (props: { editable?: boolean; onSave?: (html: string) => void } = {}) => {
  render(
    <HtmlArtifactPopupHost>
      <MessageHtmlArtifact artifactId="artifact" html="<h1>Hello</h1>" kind="fragment" {...props} />
    </HtmlArtifactPopupHost>
  )

  // 产物卡片的放大按钮是弹窗的唯一入口。
  fireEvent.click(screen.getByTestId('html-artifact-open-popup'))

  // 弹窗是 lazy 导入的，慢机器上首帧要等一个 chunk。
  await waitFor(() => expect(screen.getByTestId('artifact-code-editor')).toBeInTheDocument(), { timeout: 10000 })
  return screen.getByTestId('artifact-code-editor')
}

describe('HtmlArtifactsPopup readonly contract', () => {
  beforeEach(() => {
    window.toast = { success: vi.fn(), error: vi.fn() } as any
  })

  it('keeps the fail-closed read-only session read-only inside the popup', async () => {
    const editor = await openPopup()

    expect(editor).toHaveAttribute('data-editable', 'false')
    expect(editor).toHaveAttribute('contenteditable', 'false')
  })

  it('does not claim a save when the session has no onSave handler', async () => {
    await openPopup()
    const popup = screen.getByTestId('html-artifact-save')

    fireEvent.click(popup)

    expect(popup).not.toHaveAttribute('data-saved')
    expect(window.toast.error).toHaveBeenCalled()
  })

  it('passes an editable session through and only ticks the save button when a handler exists', async () => {
    const onSave = vi.fn()
    const editor = await openPopup({ editable: true, onSave })
    expect(editor).toHaveAttribute('data-editable', 'true')

    const popup = screen.getByTestId('html-artifact-save')
    expect(popup).not.toHaveAttribute('data-saved')

    fireEvent.click(popup)

    await waitFor(() => expect(popup).toHaveAttribute('data-saved', 'true'))
    expect(onSave).toHaveBeenCalledWith('<h1>Hello</h1>')
  })
})
