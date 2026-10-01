/**
 * 动态工具栏命令必须真的能执行。
 *
 * 原状：`getToolbarItems()` 把 `Command.handler` 包成 `() => cmd.handler` 存进 `handler` 字段，
 * 而**没有任何地方读取它**；渲染侧只认 `item.command`（由 `formattingCommand` 强转而来）。
 * 于是通过公开 API（`registerToolbarCommand`）注册、但没有 `formattingCommand` 的命令
 * 是一个静默失效的扩展点。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { Tv } from 'lucide-react'
import type * as ReactI18next from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerToolbarCommand, unregisterCommand } from '../command'
import { Toolbar } from '../toolbar'
import type { FormattingState } from '../types'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('../components/ImageUploader', () => ({ ImageUploader: () => null }))
vi.mock('../components/MathInputDialog', () => ({ default: () => null }))

const formattingState = {} as FormattingState

const COMMAND_ID = 'probe-command'

describe('RichEditor toolbar dynamic commands', () => {
  afterEach(() => {
    unregisterCommand(COMMAND_ID)
  })

  it('runs the command handler of a toolbar command that has no formattingCommand', () => {
    const handler = vi.fn()
    const editor = { id: 'fake-editor' }

    registerToolbarCommand({
      id: COMMAND_ID,
      title: 'Probe',
      description: 'probe',
      category: 'special' as never,
      icon: Tv,
      keywords: [],
      handler,
      showInToolbar: true,
      toolbarGroup: 'history'
    })

    render(
      <Toolbar
        editor={editor as never}
        formattingState={formattingState}
        onCommand={vi.fn()}
        scrollContainer={{ current: null }}
      />
    )

    const button = screen.getByTestId(`toolbar-${COMMAND_ID}`)
    expect(button).toHaveAccessibleName('Probe')

    fireEvent.click(button)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(editor)
  })
})
