import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  scrollIntoView: vi.fn(),
  setTimeoutTimer: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
  }
}))
vi.mock('@renderer/config/env', () => ({ APP_NAME: 'Cherry Studio', AppLogo: 'app-logo', isLocalAi: false }))
vi.mock('@renderer/config/models', () => ({ getModelLogoById: () => undefined }))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/hooks/useAvatar', () => ({ default: () => 'ab' }))

vi.mock('@renderer/hooks/useSettings', () => {
  const settings = { userName: 'User' }
  // s2-04 起组件按字段订阅（`useSetting(key)`），桩必须逐键取真值。
  return { useSettings: () => settings, useSetting: (key: string) => settings[key] }
})
vi.mock('@renderer/services/MessagesService', () => ({ getMessageModelId: (message: Message) => message.modelId }))
vi.mock('@renderer/services/ModelService', () => ({ getModelName: () => '' }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => mocks.dispatch }))
vi.mock('@renderer/store/newMessage', () => ({ newMessagesActions: { updateMessage: vi.fn() } }))
vi.mock('@renderer/utils', () => ({ isEmoji: () => false, removeLeadingEmoji: (value: string) => value }))
vi.mock('@renderer/utils/dom', () => ({ scrollIntoView: mocks.scrollIntoView }))
vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: (message: Message) => (message.blocks ?? []).join(',')
}))
vi.mock('@renderer/components/Avatar/EmojiAvatar', () => ({ default: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { default: MessageAnchorLine } = await import('../MessageAnchorLine')

const createMessage = (id: string, role: Message['role'], text: string) =>
  ({ id, role, blocks: [text], modelId: undefined }) as unknown as Message

beforeAll(() => {
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

describe('MessageAnchorLine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('scrolls the column-reverse container to its visual bottom (top: 0) from the bottom anchor', () => {
    const scrollTo = vi.fn()
    const messagesContainer = document.createElement('div')
    messagesContainer.id = 'messages'
    messagesContainer.scrollTo = scrollTo
    Object.defineProperty(messagesContainer, 'scrollHeight', { value: 5000, configurable: true })
    document.body.appendChild(messagesContainer)

    const { container } = render(<MessageAnchorLine messages={[createMessage('m1', 'user', 'hello')]} />)

    // 底部锚点是 MessagesList 的第一项，其图标是本组件里唯一的 svg
    const chevron = container.querySelector('svg')
    expect(chevron).not.toBeNull()
    fireEvent.click(chevron!.parentElement as HTMLElement)

    // column-reverse 坐标系：scrollTop = 0 才是视觉底部
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 5000 }))
  })

  it('renders one row per message with its main-text preview', () => {
    const { getByText } = render(
      <MessageAnchorLine messages={[createMessage('m1', 'user', 'hello'), createMessage('m2', 'assistant', 'world')]} />
    )

    expect(getByText('hello')).toBeTruthy()
    expect(getByText('world')).toBeTruthy()
  })

  it('scrolls to the message element when a row is clicked', () => {
    const messageElement = document.createElement('div')
    messageElement.id = 'message-m1'
    document.body.appendChild(messageElement)

    const { getByText } = render(<MessageAnchorLine messages={[createMessage('m1', 'user', 'hello')]} />)
    fireEvent.click(getByText('hello'))

    expect(mocks.scrollIntoView).toHaveBeenCalledWith(messageElement, expect.objectContaining({ block: 'start' }))
  })

  it('caches hover measurements instead of re-reading layout on every streaming update', () => {
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    const messages = [createMessage('m1', 'user', 'hello'), createMessage('m2', 'assistant', 'world')]

    const { container, rerender } = render(<MessageAnchorLine messages={messages} />)
    const line = container.firstElementChild as HTMLElement

    // 进入 hover 态（mouseY != null）后才会有距离量测量
    fireEvent.mouseMove(line, { clientY: 40 })
    expect(rectSpy.mock.calls.length).toBeGreaterThan(0)
    rectSpy.mockClear()

    // 流式 delta 的形状：条数与末条 id 不变，只有数组引用换新
    rerender(<MessageAnchorLine messages={[...messages]} />)
    expect(rectSpy).not.toHaveBeenCalled()
    rectSpy.mockRestore()
  })
})
