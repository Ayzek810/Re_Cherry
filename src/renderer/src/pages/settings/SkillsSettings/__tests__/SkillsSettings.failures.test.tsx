import '@renderer/i18n'

import type { InstalledSkill } from '@renderer/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 技能库的失败语义（v1 二轮审查 s2-12 / s2-13 / s2-45）。
 *
 * s2-12：hook 已经把失败暴露为 `error`，消费方却丢了它 —— 三个注册表（含网络）全失败时
 *        下拉显示的是「没有结果」，一个权威的「市场上没有这个技能」结论。
 * s2-13：批量卸载丢弃逐条结果，永远报「已卸载 N 个」，与 hook 内逐条 error toast 互相矛盾。
 * s2-45：文件浏览的主进程 IPC 未接线，空态却写着「选择文件」——那是做不到的事。
 */

const mocks = vi.hoisted(() => ({
  skills: [] as InstalledSkill[],
  uninstall: vi.fn(),
  searchError: null as string | null,
  search: vi.fn()
}))

vi.mock('@renderer/hooks/useSkills', () => ({
  useInstalledSkills: () => ({
    skills: mocks.skills,
    loading: false,
    error: null,
    refresh: vi.fn(),
    toggle: vi.fn(),
    uninstall: mocks.uninstall
  }),
  useSkillSearch: () => ({
    results: [],
    searching: false,
    error: mocks.searchError,
    search: mocks.search,
    clear: vi.fn()
  }),
  useSkillInstall: () => ({
    installingKey: null,
    isInstalling: () => false,
    install: vi.fn(),
    installFromZip: vi.fn(),
    installFromDirectory: vi.fn()
  })
}))

import SkillsSettings from '../SkillsSettings'

const skill = (id: string, name: string): InstalledSkill =>
  ({ id, name, description: null, source: 'local', sourceUrl: null }) as unknown as InstalledSkill

const modalConfirm = vi.fn()

beforeEach(() => {
  mocks.skills = [skill('s1', 'Alpha'), skill('s2', 'Beta')]
  mocks.uninstall.mockReset()
  mocks.search.mockReset()
  mocks.searchError = null
  modalConfirm.mockReset()
  modalConfirm.mockImplementation(({ onOk }: { onOk?: () => void }) => {
    void onOk?.()
  })
  window.modal = { confirm: modalConfirm, error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } as never
  window.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } as unknown as typeof window.toast
  vi.spyOn(message, 'success').mockImplementation(() => undefined as never)
  vi.spyOn(message, 'warning').mockImplementation(() => undefined as never)
})

describe('技能库搜索与批量卸载的失败语义', () => {
  it('搜索失败渲染错误态与重试，而不是「没有结果」', async () => {
    mocks.searchError = 'registry unreachable'

    render(<SkillsSettings />)
    fireEvent.change(screen.getByPlaceholderText(/发现更多技能|Discover more skills/i), { target: { value: 'pdf' } })

    await waitFor(() => expect(screen.getByText(/搜索失败|Search failed|registry unreachable/i)).toBeInTheDocument())
    expect(screen.queryByText(/未找到技能|No results found|noResults/i)).toBeNull()
  })

  it('批量卸载有失败项时按「N 成功 / M 失败」报告，并保留失败项的选中态', async () => {
    mocks.uninstall.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    render(<SkillsSettings />)

    // 右键 → 「多选」
    fireEvent.contextMenu(screen.getByText('Alpha'))
    const multiSelect = await screen.findByText(/多选|Multi-select|multiSelect/i)
    fireEvent.click(multiSelect)

    // 勾选两条 → 点垃圾桶
    fireEvent.click(await screen.findByText('Alpha'))
    fireEvent.click(screen.getByText('Beta'))
    const trash = document.querySelector('.ant-btn-dangerous') as HTMLButtonElement
    fireEvent.click(trash)

    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledTimes(2))
    expect(message.warning).toHaveBeenCalled()
    expect(message.success).not.toHaveBeenCalled()
  })

  it('全部成功才报成功', async () => {
    mocks.uninstall.mockResolvedValue(true)

    render(<SkillsSettings />)

    fireEvent.contextMenu(screen.getByText('Alpha'))
    fireEvent.click(await screen.findByText(/多选|Multi-select|multiSelect/i))
    fireEvent.click(await screen.findByText('Alpha'))
    fireEvent.click(screen.getByText('Beta'))
    fireEvent.click(document.querySelector('.ant-btn-dangerous') as HTMLButtonElement)

    await waitFor(() => expect(message.success).toHaveBeenCalled())
    expect(message.warning).not.toHaveBeenCalled()
  })

  it('技能详情说明文件浏览尚未接线，而不是提示「选择文件」', async () => {
    render(<SkillsSettings />)

    fireEvent.click(screen.getByText('Alpha'))

    await waitFor(() =>
      expect(screen.getAllByText(/尚未接入技能文件浏览|File browsing is not wired up/i).length).toBeGreaterThan(0)
    )
    expect(screen.queryByText(/选择文件|Select a file/i)).toBeNull()
  })
})
