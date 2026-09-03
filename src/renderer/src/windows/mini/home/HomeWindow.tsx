import { loggerService } from '@logger'
import { isMac } from '@renderer/config/constant'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { getAssistantMessage, getUserMessage } from '@renderer/services/MessagesService'
import store, { useAppSelector } from '@renderer/store'
import { removeManyBlocks, updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { ThemeMode } from '@renderer/types'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { Divider } from 'antd'
import { isEmpty, last } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatWindow from '../chat/ChatWindow'
import ClipboardPreview from './components/ClipboardPreview'
import type { FeatureMenusRef } from './components/FeatureMenus'
import FeatureMenus from './components/FeatureMenus'
import Footer from './components/Footer'
import InputBar from './components/InputBar'

const logger = loggerService.withContext('HomeWindow')

/** 快捷助手固定标识：不依赖任何 Assistant 配置，消息也不计入聊天消息库 */
const MINI_ASSISTANT_ID = 'quick-assistant'

const HomeWindow: FC<{ draggable?: boolean }> = ({ draggable = true }) => {
  const { language, readClipboardAtStartup, quickAssistantPrompt, windowStyle } = useSettings()
  const { theme } = useTheme()
  const { t } = useTranslation()
  const { quickAssistantModel } = useAppSelector((state) => state.llm)

  /** 内嵌预览（设置页）时不主动抢焦点；真实小窗（mini window）由窗口显示事件聚焦。 */
  const isEmbedded = !draggable

  // 快捷助手 = 独立简单 chatbot：模型与提示词来自快捷助手设置，不读取 assistants 列表
  const miniAssistant = useMemo<Assistant>(
    () => ({
      id: MINI_ASSISTANT_ID,
      name: t('settings.quickAssistant.title'),
      prompt: quickAssistantPrompt || '',
      topics: [],
      type: 'assistant',
      settings: {},
      model: quickAssistantModel
    }),
    [quickAssistantPrompt, quickAssistantModel, t]
  )
  const currentAssistant = miniAssistant

  const [route, setRoute] = useState<'home' | 'chat' | 'summary' | 'explanation'>('home')
  const [isFirstMessage, setIsFirstMessage] = useState(true)

  const [userInputText, setUserInputText] = useState('')

  const [clipboardText, setClipboardText] = useState('')
  const lastClipboardTextRef = useRef<string | null>(null)

  const [isPinned, setIsPinned] = useState(false)

  // Indicator for loading(thinking/streaming)
  const [isLoading, setIsLoading] = useState(false)
  // Indicator for whether the first message is outputted
  const [isOutputted, setIsOutputted] = useState(false)

  const [error, setError] = useState<string | null>(null)

  const currentTopic = useRef<Topic>(getDefaultTopic(MINI_ASSISTANT_ID))
  const currentAskId = useRef('')
  // dsh:complete 无法中途取消：暂停/清除时置位，结果返回后丢弃
  const cancelledRef = useRef(false)

  const inputBarRef = useRef<HTMLDivElement>(null)
  const featureMenusRef = useRef<FeatureMenusRef>(null)

  const referenceText = useMemo(() => clipboardText || userInputText, [clipboardText, userInputText])

  const userContent = useMemo(() => {
    if (isFirstMessage) {
      return referenceText === userInputText ? userInputText : `${referenceText}\n\n${userInputText}`.trim()
    }
    return userInputText.trim()
  }, [isFirstMessage, referenceText, userInputText])

  useEffect(() => {
    void i18n.changeLanguage(language || navigator.language || defaultLanguage)
  }, [language])

  // Reset state when switching to home route
  useEffect(() => {
    if (route === 'home') {
      setIsFirstMessage(true)
      setError(null)
    }
  }, [route])

  const focusInput = useCallback(() => {
    if (inputBarRef.current) {
      const input = inputBarRef.current.querySelector('input')
      if (input) {
        input.focus()
      }
    }
  }, [])

  // 真实小窗：一轮输出结束后把焦点还给输入条，便于连续对话。
  // 内嵌预览（设置页）不做任何自动聚焦，避免打断提示词编辑。
  const wasLoadingRef = useRef(isLoading)
  useEffect(() => {
    if (isEmbedded) return
    if (wasLoadingRef.current && !isLoading) {
      focusInput()
    }
    wasLoadingRef.current = isLoading
  }, [isLoading, isEmbedded, focusInput])

  // Use useCallback with stable dependencies to avoid infinite loops
  const readClipboard = useCallback(async () => {
    if (!readClipboardAtStartup || !document.hasFocus()) return

    try {
      const text = await navigator.clipboard.readText()
      if (text && text !== lastClipboardTextRef.current) {
        lastClipboardTextRef.current = text
        setClipboardText(text.trim())
      }
    } catch (error) {
      // Silently handle clipboard read errors (common in some environments)
      logger.warn('Failed to read clipboard:', error as Error)
    }
  }, [readClipboardAtStartup])

  const clearClipboard = useCallback(async () => {
    setClipboardText('')
    lastClipboardTextRef.current = null
    focusInput()
  }, [focusInput])

  const onWindowShow = useCallback(async () => {
    await readClipboard()
    focusInput()
  }, [readClipboard, focusInput])

  useEffect(() => {
    void window.api.miniWindow.setPin(isPinned)
  }, [isPinned])

  useEffect(() => {
    window.electron.ipcRenderer.on(IpcChannel.ShowMiniWindow, onWindowShow)

    return () => {
      window.electron.ipcRenderer.removeAllListeners(IpcChannel.ShowMiniWindow)
    }
  }, [onWindowShow])

  useEffect(() => {
    void readClipboard()
  }, [readClipboard])

  const handleCloseWindow = useCallback(() => window.api.miniWindow.hide(), [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 使用非直接输入法时（例如中文、日文输入法），存在输入法键入过程
    // 键入过程不应有任何响应
    // 例子，中文输入法候选词过程使用`Enter`直接上屏字母，日文输入法候选词过程使用`Enter`输入假名
    // 输入法可以`Esc`终止候选词过程
    // 这两个例子的`Enter`和`Esc`快捷助手都不应该响应
    if (e.nativeEvent.isComposing || e.key === 'Process') {
      return
    }

    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        {
          if (isLoading) return

          e.preventDefault()
          if (userContent) {
            if (route === 'home') {
              featureMenusRef.current?.useFeature()
            } else {
              // Currently text input is only available in 'chat' mode
              setRoute('chat')
              void handleSendMessage()
              focusInput()
            }
          }
        }
        break
      case 'Backspace':
        {
          if (userInputText.length === 0) {
            void clearClipboard()
          }
        }
        break
      case 'ArrowUp':
        {
          if (route === 'home') {
            e.preventDefault()
            featureMenusRef.current?.prevFeature()
          }
        }
        break
      case 'ArrowDown':
        {
          if (route === 'home') {
            e.preventDefault()
            featureMenusRef.current?.nextFeature()
          }
        }
        break
      case 'Escape':
        {
          handleEsc()
        }
        break
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUserInputText(e.target.value)
  }

  const handleError = (error: Error) => {
    setIsLoading(false)
    setError(error.message)
  }

  const handleSendMessage = useCallback(
    async (prompt?: string) => {
      if (isEmpty(userContent) || !currentTopic.current) {
        return
      }

      const topicId = currentTopic.current.id
      cancelledRef.current = false

      try {
        const { message: userMessage, blocks } = getUserMessage({
          content: [prompt, userContent].filter(Boolean).join('\n\n'),
          assistant: currentAssistant,
          topic: currentTopic.current
        })

        store.dispatch(newMessagesActions.addMessage({ topicId, message: userMessage }))
        store.dispatch(upsertManyBlocks(blocks))

        const assistantMessage = getAssistantMessage({
          assistant: currentAssistant,
          topic: currentTopic.current
        })
        assistantMessage.askId = userMessage.id
        currentAskId.current = userMessage.id

        store.dispatch(newMessagesActions.addMessage({ topicId, message: assistantMessage }))

        setIsLoading(true)
        setIsOutputted(false)
        setError(null)

        setIsFirstMessage(false)
        setUserInputText('')

        const model = currentAssistant.model
        if (!model || !model.provider) {
          throw new Error('Quick assistant model is not configured')
        }

        // 快捷助手 = 独立简单 chatbot：携带本窗口 Redux 中的上下文做一次性流式 completion，
        // 不创建内核会话、不写入任何持久化存储，消息不计入聊天消息库
        const history = selectMessagesForTopic(store.getState(), topicId)
        const context = history
          .filter((m) => m && m.role !== 'system')
          .slice(-20)
          .map((m) => ({ role: m.role as 'user' | 'assistant', text: getMainTextContent(m) }))
          .filter((m) => m.text.length > 0)
        const system = await replacePromptVariables(currentAssistant.prompt, model.name)

        // 流式回复块
        const replyBlock = createMainTextBlock(assistantMessage.id, '', { status: MessageBlockStatus.STREAMING })
        store.dispatch(upsertManyBlocks([replyBlock]))
        store.dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: assistantMessage.id,
            updates: { blocks: [replyBlock.id], status: AssistantMessageStatus.PROCESSING }
          })
        )

        // rAF 合并文本增量，避免高频 delta 刷爆渲染
        let streamedText = ''
        let rafId = 0
        const flushText = () => {
          store.dispatch(updateOneBlock({ id: replyBlock.id, changes: { content: streamedText } }))
        }

        await window.api.dshStreamComplete(
          {
            requestId: assistantMessage.id,
            provider: model.provider,
            model: model.id,
            system: system || undefined,
            messages: context
          },
          (data) => {
            if (cancelledRef.current) return
            const event = data as { type: string; text?: string; message?: string }
            if (event.type === 'delta' && event.text !== undefined) {
              streamedText += event.text
              if (rafId === 0) {
                rafId = requestAnimationFrame(() => {
                  rafId = 0
                  flushText()
                })
              }
            } else if (event.type === 'done') {
              if (rafId !== 0) {
                cancelAnimationFrame(rafId)
                rafId = 0
              }
              flushText()
              store.dispatch(
                updateOneBlock({
                  id: replyBlock.id,
                  changes: { content: streamedText, status: MessageBlockStatus.SUCCESS }
                })
              )
              store.dispatch(
                newMessagesActions.updateMessage({
                  topicId,
                  messageId: assistantMessage.id,
                  updates: { status: AssistantMessageStatus.SUCCESS }
                })
              )
              setIsLoading(false)
              setIsOutputted(true)
              currentAskId.current = ''
            } else if (event.type === 'error') {
              if (rafId !== 0) {
                cancelAnimationFrame(rafId)
                rafId = 0
              }
              store.dispatch(updateOneBlock({ id: replyBlock.id, changes: { status: MessageBlockStatus.ERROR } }))
              store.dispatch(
                newMessagesActions.updateMessage({
                  topicId,
                  messageId: assistantMessage.id,
                  updates: { status: AssistantMessageStatus.ERROR }
                })
              )
              setIsLoading(false)
              setIsOutputted(true)
              currentAskId.current = ''
              setError(event.message || 'An error occurred')
            }
          }
        )
      } catch (err) {
        if (cancelledRef.current) {
          return
        }
        handleError(err instanceof Error ? err : new Error('An error occurred'))
        logger.error('Quick assistant error:', err as Error)
      }
    },
    [userContent, currentAssistant]
  )

  const handlePause = useCallback(() => {
    if (currentAskId.current) {
      // 丢弃本次流式结果并收尾 UI
      cancelledRef.current = true
      const topicId = currentTopic.current?.id
      if (topicId) {
        const state = store.getState()
        const messageIds = state.messages.messageIdsByTopic[topicId] ?? []
        const pending = messageIds
          .map((id) => state.messages.entities[id])
          .find((m) => m && m.role === 'assistant' && m.id === currentAskId.current)
        if (pending) {
          store.dispatch(removeManyBlocks(pending.blocks ?? []))
          store.dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: pending.id,
              updates: { blocks: [], status: AssistantMessageStatus.PAUSED }
            })
          )
        }
      }
      setIsLoading(false)
      setIsOutputted(true)
      currentAskId.current = ''
    }
  }, [])

  const handleEsc = useCallback(() => {
    if (isLoading) {
      handlePause()
    } else {
      if (route === 'home') {
        void handleCloseWindow()
      } else {
        // Clear the topic messages to reduce memory usage
        if (currentTopic.current) {
          store.dispatch(newMessagesActions.clearTopicMessages(currentTopic.current.id))
        }

        // Reset the topic
        currentTopic.current = getDefaultTopic(MINI_ASSISTANT_ID)

        // Reset selection only after using a feature and returning to home.
        featureMenusRef.current?.resetSelectedIndex()
        setError(null)
        setRoute('home')
        setUserInputText('')
      }
    }
  }, [isLoading, route, handleCloseWindow, currentAssistant.id, handlePause])

  const handleCopy = useCallback(() => {
    if (!currentTopic.current) return

    const messages = selectMessagesForTopic(store.getState(), currentTopic.current.id)
    const lastMessage = last(messages)

    if (lastMessage) {
      const content = getMainTextContent(lastMessage)
      void navigator.clipboard.writeText(content)
      window.toast.success(t('message.copy.success'))
    }
  }, [currentTopic, t])

  const backgroundColor = useMemo(() => {
    // ONLY MAC: when transparent style + light theme: use vibrancy effect
    // because the dark style under mac's vibrancy effect has not been implemented
    if (isMac && windowStyle === 'transparent' && theme === ThemeMode.light) {
      return 'transparent'
    }
    return 'var(--color-background)'
  }, [windowStyle, theme])

  // Memoize placeholder text
  const inputPlaceholder = useMemo(() => {
    if (referenceText && route === 'home') {
      return t('miniwindow.input.placeholder.title')
    }
    return t('miniwindow.input.placeholder.empty', {
      model: currentAssistant.model?.name || ''
    })
  }, [referenceText, route, t, currentAssistant])

  // Memoize footer props
  const baseFooterProps = useMemo(
    () => ({
      route,
      loading: isLoading,
      onEsc: handleEsc,
      setIsPinned,
      isPinned
    }),
    [route, isLoading, handleEsc, isPinned]
  )

  switch (route) {
    case 'chat':
    case 'summary':
    case 'explanation':
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          {route === 'chat' && (
            <>
              <InputBar
                text={userInputText}
                assistant={currentAssistant}
                placeholder={inputPlaceholder}
                handleKeyDown={handleKeyDown}
                handleChange={handleChange}
                ref={inputBarRef}
              />
              <Divider style={{ margin: '10px 0' }} />
            </>
          )}
          {['summary', 'explanation'].includes(route) && (
            <div style={{ marginTop: 10 }}>
              <ClipboardPreview referenceText={referenceText} clearClipboard={clearClipboard} t={t} />
            </div>
          )}
          <ChatWindow
            route={route}
            assistant={currentAssistant}
            topic={currentTopic.current}
            isOutputted={isOutputted}
          />
          {error && <ErrorMsg>{error}</ErrorMsg>}

          <Divider style={{ margin: '10px 0' }} />
          <Footer key="footer" {...baseFooterProps} onCopy={handleCopy} />
        </Container>
      )

    // Home
    default:
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          <InputBar
            text={userInputText}
            assistant={currentAssistant}
            placeholder={inputPlaceholder}
            handleKeyDown={handleKeyDown}
            handleChange={handleChange}
            ref={inputBarRef}
          />
          <Divider style={{ margin: '10px 0' }} />
          <ClipboardPreview referenceText={referenceText} clearClipboard={clearClipboard} t={t} />
          <Main>
            <FeatureMenus
              setRoute={setRoute}
              onSendMessage={handleSendMessage}
              text={userContent}
              ref={featureMenusRef}
            />
          </Main>
          <Divider style={{ margin: '10px 0' }} />
          <Footer
            key="footer"
            {...baseFooterProps}
            canUseBackspace={userInputText.length > 0 || clipboardText.length === 0}
            clearClipboard={clearClipboard}
          />
        </Container>
      )
  }
}

const Container = styled.div<{ $draggable: boolean }>`
  display: flex;
  flex: 1;
  height: 100%;
  width: 100%;
  flex-direction: column;
  -webkit-app-region: ${({ $draggable }) => ($draggable ? 'drag' : 'no-drag')};
  padding: 8px 10px;
`

const Main = styled.main`
  display: flex;
  flex-direction: column;

  flex: 1;
  overflow: hidden;
`

const ErrorMsg = styled.div`
  color: var(--color-error);
  background: rgba(255, 0, 0, 0.15);
  border: 1px solid var(--color-error);
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  word-break: break-all;
`

export default HomeWindow
