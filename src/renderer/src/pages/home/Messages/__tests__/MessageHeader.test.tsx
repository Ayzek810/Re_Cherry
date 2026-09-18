import type { Assistant, Model, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import MessageHeader from '../MessageHeader'

beforeAll(() => {
  // antd Avatar/Tooltip 依赖 matchMedia（jsdom 未内置）
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

vi.mock('@renderer/config/env', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    isLocalAi: false,
    APP_NAME: 'Cherry Studio',
    AppLogo: 'app-logo'
  }
})
vi.mock('@renderer/services/ModelService', () => ({
  getModelName: (model?: Model) => model?.name ?? ''
}))
vi.mock('@renderer/services/MessagesService', () => ({
  getMessageModelId: (message: Partial<Message>) => message?.modelId
}))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ userName: 'User', sidebarIcons: { visible: [], disabled: [] } }),
  useMessageStyle: () => ({ isBubbleStyle: false })
}))
vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({ isMultiSelectMode: false, selectedMessageIds: [], handleSelectMessage: vi.fn() })
}))
vi.mock('@renderer/hooks/useMinappPopup', () => ({
  useMinappPopup: () => ({ openMinappById: vi.fn() })
}))
vi.mock('@renderer/hooks/useAvatar', () => ({ default: () => '😊' }))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/components/Popups/UserPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/hooks/useAssistantIdentityImage', () => ({ default: () => undefined }))

const baseMessage = {
  id: 'msg-1',
  role: 'assistant',
  assistantId: 'a-1',
  topicId: 't-1',
  createdAt: '2026-09-17T10:30:00.000Z',
  status: 'success',
  blocks: []
} as unknown as Message

const baseModel = { id: 'm-1', name: 'DeepSeek-Chat', provider: 'deepseek' } as unknown as Model
const baseTopic = { id: 't-1' } as unknown as Topic

const renderHeader = (assistantSettings?: Assistant['settings']) => {
  const assistant = {
    id: 'a-1',
    name: '🤖测试助手',
    prompt: '',
    type: 'assistant',
    topics: [],
    settings: assistantSettings
  } as unknown as Assistant
  return render(<MessageHeader message={baseMessage} assistant={assistant} model={baseModel} topic={baseTopic} />)
}

describe('MessageHeader 对话页显示挡位', () => {
  it("默认（'model'）：标题行显示模型名，时间戳行不含模型名", () => {
    const { container } = renderHeader(undefined)

    expect(container.textContent).toContain('DeepSeek-Chat')

    const info = container.querySelector('.message-header-info-wrap')
    expect(info?.textContent).not.toContain('DeepSeek-Chat')
    expect(info?.textContent).toMatch(/\d{2}\/\d{2}/)
  })

  it("'assistant'：标题行显示助手名（剥掉名称首 emoji），模型名进时间戳右侧，头像走助手标识", () => {
    const { container } = renderHeader({ messageIdentity: 'assistant' })

    expect(container.textContent).toContain('测试助手')
    // 助手标识头像渲染了名称首 emoji
    expect(container.textContent).toContain('🤖')

    const info = container.querySelector('.message-header-info-wrap')
    expect(info?.textContent).toContain('DeepSeek-Chat')
    expect(info?.textContent).toMatch(/\d{2}\/\d{2}/)
  })
})
