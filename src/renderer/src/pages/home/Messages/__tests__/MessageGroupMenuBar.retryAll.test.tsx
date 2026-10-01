import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  regenerateAssistantMessage: vi.fn(),
  deleteGroupMessages: vi.fn(),
  loggerWarn: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: mocks.loggerWarn, info: vi.fn(), debug: vi.fn() })
  }
}))
vi.mock('@renderer/hooks/useAssistant', () => ({ useAssistant: () => ({ assistant: { id: 'a1' } }) }))
vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    deleteGroupMessages: mocks.deleteGroupMessages,
    regenerateAssistantMessage: mocks.regenerateAssistantMessage
  })
}))
vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: (message: Message) => (message.blocks ?? []).join(',')
}))
vi.mock('../MessageGroupModelList', () => ({ default: () => null }))
vi.mock('../MessageGroupSettings', () => ({ default: () => null }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key)
  })
}))

const { default: MessageGroupMenuBar } = await import('../MessageGroupMenuBar')

const failedMessage = (id: string) =>
  ({ id, askId: 'ask-1', role: 'assistant', status: 'error', blocks: [], modelId: undefined }) as unknown as Message

const topic = { id: 'topic-1' } as never

describe('MessageGroupMenuBar retry-all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.toast = { success: mocks.toastSuccess, error: mocks.toastError } as unknown as typeof window.toast
  })

  it('reports the real succeeded/failed counts and keeps going after a per-item failure', async () => {
    mocks.regenerateAssistantMessage.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)

    const { container } = render(
      <MessageGroupMenuBar
        multiModelMessageStyle="vertical"
        setMultiModelMessageStyle={vi.fn()}
        messages={[failedMessage('a1'), failedMessage('a2')]}
        selectMessageId="a1"
        setSelectedMessage={vi.fn()}
        topic={topic}
      />
    )

    const retryButton = container.querySelector('.anticon-reload')?.closest('button')
    expect(retryButton).not.toBeNull()
    fireEvent.click(retryButton as HTMLElement)

    // 两条都尝试（失败不中断后续），结果以真实计数上报
    await waitFor(() => expect(mocks.regenerateAssistantMessage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('message.group.retry_all_result:{"success":1,"failed":1}')
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1)
  })

  it('reports success when every candidate is retried', async () => {
    mocks.regenerateAssistantMessage.mockResolvedValue(undefined)

    const { container } = render(
      <MessageGroupMenuBar
        multiModelMessageStyle="vertical"
        setMultiModelMessageStyle={vi.fn()}
        messages={[failedMessage('a1')]}
        selectMessageId="a1"
        setSelectedMessage={vi.fn()}
        topic={topic}
      />
    )

    fireEvent.click(container.querySelector('.anticon-reload')?.closest('button') as HTMLElement)

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('message.group.retry_all_result:{"success":1,"failed":0}')
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
