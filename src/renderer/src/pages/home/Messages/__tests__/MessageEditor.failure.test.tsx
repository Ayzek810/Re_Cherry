import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  uploadFiles: vi.fn(async () => [])
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/hooks/useAssistant', () => ({ useAssistant: () => ({ assistant: { id: 'a1' } }) }))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = {
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1000,
    fontSize: 14,
    sendMessageShortcut: 'Enter',
    enableSpellCheck: false
  }
  // 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})
vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({ llm: { imageDescriberModel: undefined }, messages: { entities: {} } })
}))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: () => [] }))
vi.mock('@renderer/config/models', () => ({ isVisionModel: () => false, isGenerateImageModel: () => false }))
vi.mock('@renderer/services/FileManager', () => ({ default: { uploadFiles: mocks.uploadFiles } }))
vi.mock('@renderer/services/PasteService', () => ({
  default: { init: vi.fn(), registerHandler: vi.fn(), unregisterHandler: vi.fn(), setLastFocusedComponent: vi.fn() }
}))
vi.mock('@renderer/utils/input', () => ({
  getFilesFromDropEvent: vi.fn(async () => null),
  isSendMessageKeyPressed: () => false
}))
vi.mock('@renderer/utils/messageUtils/create', () => ({ createFileBlock: vi.fn(), createImageBlock: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/find', () => ({
  findAllBlocks: () => [
    { id: 'b1', type: MessageBlockType.MAIN_TEXT, content: 'hi', status: MessageBlockStatus.SUCCESS } as MessageBlock
  ]
}))
vi.mock('@renderer/utils', () => ({
  classNames: (...values: unknown[]) => values.filter(Boolean).join(' '),
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}))
vi.mock('../../Inputbar/AttachmentPreview', () => ({ FileNameRender: () => null, getFileIcon: () => null }))
vi.mock('../../Inputbar/tools/components/AttachmentButton', () => ({ default: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { default: MessageEditor } = await import('../MessageEditor')

const message = { id: 'm1', role: 'user', assistantId: 'a1', blocks: ['b1'] } as unknown as Message

beforeAll(() => {
  // antd TextArea 的 autoFocus 路径调用 scrollTo（jsdom 的 textarea 未实现）
  HTMLTextAreaElement.prototype.scrollTo = vi.fn() as unknown as typeof HTMLTextAreaElement.prototype.scrollTo
})

describe('MessageEditor save/resend failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.toast = {
      success: vi.fn(),
      error: mocks.toastError,
      warning: vi.fn(),
      info: vi.fn()
    } as unknown as typeof window.toast
  })

  it('awaits onSave, reports the failure and re-enables the save action', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('save boom'))

    const { getByLabelText } = render(
      <MessageEditor message={message} topicId="t1" onSave={onSave} onResend={vi.fn()} onCancel={vi.fn()} />
    )

    const saveButton = getByLabelText('common.save') as HTMLButtonElement
    fireEvent.click(saveButton)

    // onSave 被 await：失败必须走到 catch（旧实现不 await，Promise 直接被丢弃）
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('message.edit.save_failed'))
    expect(onSave).toHaveBeenCalledTimes(1)
    // finally 解锁：旧实现没有任何复位路径，按钮永久置灰
    await waitFor(() => expect((getByLabelText('common.save') as HTMLButtonElement).disabled).toBe(false))
  })

  it('unlocks the resend action when onResend rejects', async () => {
    const onResend = vi.fn().mockRejectedValue(new Error('resend boom'))

    const { getByLabelText } = render(
      <MessageEditor message={message} topicId="t1" onSave={vi.fn()} onResend={onResend} onCancel={vi.fn()} />
    )

    fireEvent.click(getByLabelText('chat.resend'))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('message.edit.resend_failed'))
    await waitFor(() => expect((getByLabelText('chat.resend') as HTMLButtonElement).disabled).toBe(false))
  })

  it('keeps the actions usable while saving succeeds', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)

    const { getByLabelText } = render(
      <MessageEditor message={message} topicId="t1" onSave={onSave} onResend={vi.fn()} onCancel={vi.fn()} />
    )

    fireEvent.click(getByLabelText('common.save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).not.toHaveBeenCalled()
    await waitFor(() => expect((getByLabelText('common.save') as HTMLButtonElement).disabled).toBe(false))
  })
})
