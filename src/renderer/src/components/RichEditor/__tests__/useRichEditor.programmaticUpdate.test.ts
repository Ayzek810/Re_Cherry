/**
 * 程序化写入必须回流到 onChange。
 *
 * 缺陷原状：onUpdate 里的 `!editor.isFocused` 守卫把「焦点不在编辑器上」的程序化编辑
 * 一律丢弃。数学弹窗的焦点在它自己的 textarea 上、加号按钮的焦点在该按钮上，
 * 于是公式写进了编辑器却从未通知父组件 —— 笔记只从 onChange 落盘，公式写不进 .md，
 * 随后被「编辑器内容 ≠ 磁盘内容」的同步逻辑静默回滚。
 *
 * 本测试直接用真实 tiptap 编辑器制造一次**不聚焦**的程序化事务，钉住：
 *  1. 程序化编辑触发 onChange，且 markdown 里真的有公式；
 *  2. setMarkdown 这种整体替换不会二次回流（避免覆盖调用方刚写入的内容）。
 */
import { renderHook, waitFor } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useRichEditor } from '../useRichEditor'

// 富文本编辑器只在 CodeStyleProvider 下取 shiki 主题；本测试不渲染主题相关 UI。
vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({ activeShikiTheme: 'github-light' })
}))

// 保留模块其余导出（i18n/index.ts 依赖 initReactI18next，整体替换会让测试文件加载失败）。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const renderEditor = (options: Parameters<typeof useRichEditor>[0] = {}) => renderHook(() => useRichEditor(options))

describe('useRichEditor programmatic edits', () => {
  beforeEach(() => {
    window.toast = { success: vi.fn(), error: vi.fn() } as any
  })

  it('reflows a programmatic math insertion that happens while the editor is not focused', async () => {
    const onChange = vi.fn()
    const onHtmlChange = vi.fn()
    const { result } = renderEditor({ initialContent: 'intro', onChange, onHtmlChange })

    await waitFor(() => expect(result.current.editor).toBeTruthy())

    const editor = result.current.editor
    expect(editor.isFocused).toBe(false)

    editor.chain().insertBlockMath({ latex: 'x^2' }).run()

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('x^2')
    expect(onHtmlChange).toHaveBeenCalled()
  })

  it('reflows the plus-button style content insertion made through the public command API', async () => {
    const onChange = vi.fn()
    const { result } = renderEditor({ initialContent: 'intro', onChange })

    await waitFor(() => expect(result.current.editor).toBeTruthy())

    const editor = result.current.editor
    editor.commands.insertContent('// slash')

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('// slash')
  })

  it('does not re-emit when the caller replaces the whole document with setMarkdown', async () => {
    const onChange = vi.fn()
    const { result } = renderEditor({ initialContent: 'intro', onChange })

    await waitFor(() => expect(result.current.editor).toBeTruthy())

    result.current.setMarkdown('# replaced\n\nbody')

    // 整体替换只允许 setMarkdown 自己那一次通知，不能因为 setContent 触发的事务再回流一遍。
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenLastCalledWith('# replaced\n\nbody')
  })
})
