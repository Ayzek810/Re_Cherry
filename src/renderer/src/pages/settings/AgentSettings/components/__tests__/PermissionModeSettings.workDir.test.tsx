/**
 * v0.3.1-2：工作目录"修改目录"按钮行为测试。
 *
 * 需求（用户）：助手设置 → 权限模式 → 工作目录 右侧加一个"打开文件管理器选目录"的按钮，
 * 机制与 设置 → 应用数据 的"修改目录"一致（`window.api.select({properties:['openDirectory','createDirectory']})`）。
 *
 * 行为级验证（§4.18）：本组件自带 assistant/updateAssistant 两个 prop，不依赖 store，
 * 故直接渲染即可断言"点按钮 → 弹选目录 → 选中路径写回助手"整条链。
 */
import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import '@renderer/i18n'

import PermissionModeSettings from '../PermissionModeSettings'

const assistant = (workMode?: Assistant['workMode']): Assistant =>
  ({ id: 'a1', name: 't', workMode }) as unknown as Assistant

const setup = (selected: string | undefined, workMode?: Assistant['workMode']) => {
  const select = vi.fn().mockResolvedValue(selected)
  ;(window as unknown as { api: unknown }).api = { select }
  const updateAssistant = vi.fn()
  const { container } = render(
    <PermissionModeSettings assistant={assistant(workMode)} updateAssistant={updateAssistant} />
  )
  // 语言无关定位：lucide 的 FolderOutput 图标（aria-label 随 i18n 语言变化，故不用它做选择器）
  const button = container.querySelector('svg.lucide-folder-output') as SVGElement | null
  if (!button) throw new Error('work dir picker button not found')
  return { select, updateAssistant, button }
}

describe('工作目录 · 修改目录按钮', () => {
  it('点击后按应用数据同一机制弹出目录选择（openDirectory + createDirectory）', async () => {
    const { select, button } = setup(undefined)
    fireEvent.click(button)
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1))
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] })
    )
  })

  it('选中目录后写回助手 workMode.workingDir，并显示在输入框', async () => {
    const { updateAssistant, button } = setup('D:\\Ws\\picked')
    fireEvent.click(button)
    await waitFor(() => expect(updateAssistant).toHaveBeenCalledTimes(1))
    expect(updateAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ workMode: expect.objectContaining({ workingDir: 'D:\\Ws\\picked' }) })
    )
    await waitFor(() => expect(screen.getByDisplayValue('D:\\Ws\\picked')).toBeInTheDocument())
  })

  it('取消选择（返回 undefined）不写回，保持原值', async () => {
    const { updateAssistant, button } = setup(undefined, {
      approval: 'read-only',
      defaultEnabled: false,
      workingDir: 'D:\\keep'
    })
    fireEvent.click(button)
    await new Promise((r) => setTimeout(r, 0))
    expect(updateAssistant).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('D:\\keep')).toBeInTheDocument()
  })
})