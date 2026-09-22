/**
 * 批次1 输入栏三开关契约测试（webSearchTool / knowledgeBaseTool / mcpToolsTool）。
 *
 * 批次1 语义：开关只做「持久化到 Assistant 字段 + 打开 QuickPanel」，不触发任何搜索/检索/
 * 服务器进程行为（接线在批次2/3/4）。本文件把这些交互契约钉住：
 * - WebSearchButton：未启用时点击打开提供商面板；已选提供商时点击关闭（清 webSearchProviderId）。
 * - KnowledgeBaseButton：面板列出 knowledge 切片 bases；选择回调 onSelect。
 * - MCPToolsButton：模式菜单三项齐全；选择 auto 写入 assistant.mcpMode。
 *
 * mock 纪律沿用 ThinkingButton.test.tsx 的教训：一律 importOriginal 展开真实导出，只覆盖
 * 需要控制的出口；不许整体替换（模块图会拉进 store/i18n 链路导致整片失败）。
 */
import type { ToolQuickPanelApi, ToolQuickPanelController } from '@renderer/pages/home/Inputbar/types'
import type { Assistant } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import KnowledgeBaseButton from '../KnowledgeBaseButton'
import MCPToolsButton from '../MCPToolsButton'
import WebSearchButton from '../WebSearchButton'

// ---- mocks ----------------------------------------------------------------

const mockUpdateAssistant = vi.fn()
const mockUseAssistant = vi.fn()

vi.mock('@renderer/hooks/useAssistant', async (importOriginal) => ({
  ...(await importOriginal()),
  useAssistant: () => mockUseAssistant()
}))

const mockUseMCPServers = vi.fn()

vi.mock('@renderer/hooks/useMCPServers', async (importOriginal) => ({
  ...(await importOriginal()),
  useMCPServers: () => mockUseMCPServers()
}))

const mockUseWebSearchProviders = vi.fn()

vi.mock('@renderer/hooks/useWebSearchProviders', async (importOriginal) => ({
  ...(await importOriginal()),
  useWebSearchProviders: () => mockUseWebSearchProviders()
}))

const mockState = {
  knowledge: { bases: [{ id: 'kb-1', name: '产品手册', items: [1, 2, 3] }] },
  websearch: {
    providers: [
      { id: 'zhipu', name: '智谱', apiKey: 'sk-test' },
      { id: 'local-google', name: 'Google', apiKey: '' }
    ]
  },
  skills: { installedSkills: [] }
}

vi.mock('@renderer/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAppSelector: (selector: (state: typeof mockState) => unknown) => selector(mockState),
  useAppDispatch: () => vi.fn()
}))

// QuickPanel：真实导出保留（QuickPanelReservedSymbol 等被组件引用），只替换 useQuickPanel。
const mockUseQuickPanelReturn = {
  open: vi.fn(),
  close: vi.fn(),
  isVisible: false,
  symbol: undefined as string | undefined
}

vi.mock('@renderer/components/QuickPanel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQuickPanel: () => mockUseQuickPanelReturn
}))

const quickPanelControllerStub = {
  isVisible: false,
  symbol: undefined,
  open: vi.fn(),
  close: vi.fn(),
  updateList: vi.fn()
} as unknown as ToolQuickPanelController

const quickPanelApiStub = {
  registerRootMenu: vi.fn(() => vi.fn()),
  registerTrigger: vi.fn(() => vi.fn())
} as unknown as ToolQuickPanelApi

const makeAssistant = (overrides: Partial<Assistant> = {}): Assistant =>
  ({
    id: 'a-1',
    name: '助手',
    emoji: '🤖',
    prompt: '',
    topics: [],
    mcpMode: 'disabled',
    ...overrides
  }) as Assistant

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockUseAssistant.mockReturnValue({
    assistant: makeAssistant(),
    updateAssistant: mockUpdateAssistant
  })
  mockUseMCPServers.mockReturnValue({
    mcpServers: [
      { id: 'srv-1', name: 'filesystem', isActive: true },
      { id: 'srv-2', name: 'fetch', isActive: false }
    ],
    // 真实 hook 的 activedMcpServers = isActive 过滤后的产物——fetch 不在内
    activedMcpServers: [{ id: 'srv-1', name: 'filesystem', isActive: true }],
    addMCPServer: vi.fn(),
    updateMCPServer: vi.fn(),
    deleteMCPServer: vi.fn(),
    setMCPServerActive: vi.fn(),
    getActiveMCPServers: vi.fn(),
    updateMcpServers: vi.fn()
  })
  mockUseWebSearchProviders.mockReturnValue({
    providers: mockState.websearch.providers,
    updateWebSearchProviders: vi.fn(),
    addWebSearchProvider: vi.fn()
  })
  mockUseQuickPanelReturn.open.mockReset()
  mockUseQuickPanelReturn.close.mockReset()
  mockUseQuickPanelReturn.isVisible = false
  mockUseQuickPanelReturn.symbol = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

// ---- WebSearchButton -------------------------------------------------------

describe('WebSearchButton（批次1：开关只写助手字段）', () => {
  it('未启用时点击打开提供商面板', () => {
    render(<WebSearchButton quickPanelController={quickPanelControllerStub} assistantId="a-1" />)

    fireEvent.click(screen.getByRole('button'))
    expect(quickPanelControllerStub.open).toHaveBeenCalled()
  })

  it('已选提供商时点击关闭并清空 webSearchProviderId', async () => {
    mockUseAssistant.mockReturnValue({
      assistant: makeAssistant({ webSearchProviderId: 'zhipu' }),
      updateAssistant: mockUpdateAssistant
    })
    render(<WebSearchButton quickPanelController={quickPanelControllerStub} assistantId="a-1" />)

    fireEvent.click(screen.getByRole('button'))
    // updateWebSearchProvider 内部有 200ms setTimeoutTimer 防抖（假定时器直接推进；
    // 不用 waitFor——其轮询 interval 在假定时器下冻结，首查不过即挂死到超时）
    await vi.advanceTimersByTimeAsync(300)
    expect(mockUpdateAssistant).toHaveBeenCalled()
    const update = mockUpdateAssistant.mock.calls[0][0] as Assistant
    expect(update.webSearchProviderId).toBeUndefined()
    expect(update.enableWebSearch).toBe(false)
  })
})

// ---- KnowledgeBaseButton ---------------------------------------------------

describe('KnowledgeBaseButton（批次1：选择写 knowledge_bases）', () => {
  it('面板列出知识库项；选择回调 onSelect', () => {
    const onSelect = vi.fn()
    render(
      <MemoryRouter>
        <KnowledgeBaseButton quickPanel={quickPanelApiStub} selectedBases={[]} onSelect={onSelect} disabled={false} />
      </MemoryRouter>
    )

    // 现行组件：注册只挂菜单，点击按钮才经 useQuickPanel.open 打开面板
    fireEvent.click(screen.getByRole('button'))
    // open 被调用时捕获列表，并直接执行「产品手册」项的 action（模拟用户点选）
    expect(mockUseQuickPanelReturn.open).toHaveBeenCalled()
    const openArg = mockUseQuickPanelReturn.open.mock.calls[0][0] as {
      list: Array<{ label: string; action: (ctx?: unknown) => void }>
    }
    const target = openArg.list.find((item) => item.label === '产品手册')
    expect(target).toBeDefined()
    target?.action({})
    expect(onSelect).toHaveBeenCalledWith([expect.objectContaining({ id: 'kb-1' })])
  })

  it('面板包含「添加知识库」与「清空」入口', () => {
    render(
      <MemoryRouter>
        <KnowledgeBaseButton quickPanel={quickPanelApiStub} selectedBases={[]} onSelect={vi.fn()} disabled={false} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button'))
    const openArg = mockUseQuickPanelReturn.open.mock.calls[0][0] as { list: Array<{ label: string }> }
    const labels = openArg.list.map((item) => item.label)
    expect(labels.length).toBeGreaterThanOrEqual(2)
  })
})

// ---- MCPToolsButton --------------------------------------------------------

describe('MCPToolsButton（批次1：模式切换写 mcpMode）', () => {
  it('模式菜单含 disabled/auto/manual 三项；选择 auto 写回助手', async () => {
    render(
      <MemoryRouter>
        <MCPToolsButton
          assistantId="a-1"
          quickPanel={quickPanelApiStub}
          setInputValue={vi.fn()}
          resizeTextArea={vi.fn()}
        />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button'))
    expect(mockUseQuickPanelReturn.open).toHaveBeenCalled()
    const openArg = mockUseQuickPanelReturn.open.mock.calls[0][0] as {
      list: Array<{ label: string; action: () => void }>
    }
    // 菜单序是组件 push 顺序（disabled/auto/manual），与 i18n 文案无关
    expect(openArg.list).toHaveLength(3)
    const autoItem = openArg.list[1]

    autoItem?.action()
    // handleModeChange 有 200ms setTimeoutTimer 防抖（同上：假定时器下不用 waitFor）
    await vi.advanceTimersByTimeAsync(300)
    expect(mockUpdateAssistant).toHaveBeenCalled()
    const update = mockUpdateAssistant.mock.calls[0][0] as Assistant
    expect(update.mcpMode).toBe('auto')
  })

  it('手动模式菜单只列 active 服务器', () => {
    render(
      <MemoryRouter>
        <MCPToolsButton
          assistantId="a-1"
          quickPanel={quickPanelApiStub}
          setInputValue={vi.fn()}
          resizeTextArea={vi.fn()}
        />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button'))
    const firstOpen = mockUseQuickPanelReturn.open.mock.calls[0][0] as {
      list: Array<{ label: string; action: () => void }>
    }
    // 菜单序同上（disabled/auto/manual），manual 第三
    expect(firstOpen.list).toHaveLength(3)
    const manualItem = firstOpen.list[2]

    // manual 项 isMenu=true，action 会二次打开服务器面板
    manualItem?.action()
    expect(mockUseQuickPanelReturn.open).toHaveBeenCalledTimes(2)
    const secondOpen = mockUseQuickPanelReturn.open.mock.calls[1][0] as {
      list: Array<{ label: string }>
    }
    const labels = secondOpen.list.map((item) => item.label)
    expect(labels.some((l) => l.includes('filesystem'))).toBe(true)
    expect(labels.some((l) => l.includes('fetch'))).toBe(false)
  })
})
