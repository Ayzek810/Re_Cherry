import { loggerService } from '@logger'
import { isMac } from '@renderer/config/constant'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { encodeImageBlobForKernel, type KernelImageInput } from '@renderer/services/kernelImages'
import { lightStream, lightStreamAbort } from '@renderer/services/lightLlm'
import { getAssistantMessage, getUserMessage } from '@renderer/services/MessagesService'
import store, { useAppSelector } from '@renderer/store'
import { updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Assistant, Topic } from '@renderer/types'
import { ThemeMode } from '@renderer/types'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { createImageBlock, createMainTextBlock, createThinkingBlock } from '@renderer/utils/messageUtils/create'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { kernelReasoningLevelFor } from '@renderer/utils/reasoningKernel'
import { defaultLanguage } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { Divider } from 'antd'
import { isEmpty, last } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ChatWindow from '../chat/ChatWindow'
import TranslateWindow from '../translate/TranslateWindow'
import ClipboardPreview from './components/ClipboardPreview'
import type { FeatureMenusRef } from './components/FeatureMenus'
import FeatureMenus from './components/FeatureMenus'
import Footer from './components/Footer'
import InputBar from './components/InputBar'

const logger = loggerService.withContext('HomeWindow')

/** 快捷助手固定标识：不依赖任何 Assistant 配置，消息也不计入聊天消息库 */
const MINI_ASSISTANT_ID = 'quick-assistant'

const HomeWindow: FC<{ draggable?: boolean }> = ({ draggable = true }) => {
  const { language, readClipboardAtStartup, quickAssistantPrompt, quickAssistantReasoningEffort, windowStyle } =
    useSettings()
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

  const [route, setRoute] = useState<'home' | 'chat' | 'translate' | 'summary' | 'explanation'>('home')
  const [isFirstMessage, setIsFirstMessage] = useState(true)

  const [userInputText, setUserInputText] = useState('')

  const [clipboardText, setClipboardText] = useState('')
  const lastClipboardTextRef = useRef<string | null>(null)

  // v0.3.3 批次5 收图入口：粘贴的图片（快捷助手视觉通路，LightLlmCall.images 批次1 已备）
  const [clipboardImage, setClipboardImage] = useState<KernelImageInput | null>(null)

  const [isPinned, setIsPinned] = useState(false)

  // Indicator for loading(thinking/streaming)
  const [isLoading, setIsLoading] = useState(false)
  // Indicator for whether the first message is outputted
  const [isOutputted, setIsOutputted] = useState(false)

  const [error, setError] = useState<string | null>(null)
  // 翻译路由的译文（由 TranslateWindow 上报）：翻译不建话题，故 `handleCopy` 拿不到
  // "最后一条助手消息"——此前翻译路由里 Footer 的「按 C 复制」胶囊点了没有任何反应。
  const [translateResult, setTranslateResult] = useState('')

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

  // fork 缝：V2 quickAssistant `HomeWindow.tsx:239-246` 的 `clear()`
  // （`stopChat()` + `setMessages([])` + `clearExecutionMessages()` + `setFlowError(null)` + `setIsPreparing(false)`）：
  // fork 等价物是「作废在途流 + 清该话题消息 + 复位执行态」三件。V2 的 `setMessages([])` 只清
  // provider 里的消息数组（= fork 按 topicId 存的消息），故这里只清当前话题的消息。
  const clearConversation = useCallback(() => {
    // ① 停流：dsh:complete 无中途取消，置位 cancelledRef 丢弃结果；同时在途流真取消
    //   （复刻 handlePause 的 requestId 约定：在途流的 requestId 就是该助手消息 id）。
    cancelledRef.current = true
    const topicId = currentTopic.current?.id
    if (topicId) {
      const state = store.getState()
      const messageIds = state.messages.messageIdsByTopic[topicId] ?? []
      const streaming = messageIds
        .map((id) => state.messages.entities[id])
        .find((m) => m !== undefined && m.role === 'assistant' && m.status === AssistantMessageStatus.PROCESSING)
      if (streaming) void lightStreamAbort(streaming.id)
    }
    // ② 清该话题消息（V2 `setMessages([])`）。
    if (topicId) store.dispatch(newMessagesActions.clearTopicMessages(topicId))
    // ③ 复位执行态：话题回默认、加载/输出标志与执行 id 归零（V2 `clearExecutionMessages()` + `setIsPreparing(false)`）。
    currentTopic.current = getDefaultTopic(MINI_ASSISTANT_ID)
    currentAskId.current = ''
    setIsLoading(false)
    setIsOutputted(false)
  }, [])

  // Reset state when switching to home route
  useEffect(() => {
    if (route === 'home') {
      // fork 缝：V2 HomeWindow.tsx:251-257 在 `route === 'home'` 时调 `clear()`——从
      // 总结/解释（或对话）返回 home 必须丢掉该话题的上下文；fork 此前只复位两个标志位，
      // 消息仍留在 store 里，下次进总结/解释看到的还是上一轮内容。`setIsFirstMessage`/`setError(null)`
      // 是 fork 既有语义（对应 V2 的 `setIsFirstMessage` / `setFlowError`），保留不动。
      setIsFirstMessage(true)
      setError(null)
      clearConversation()
    }
  }, [route, clearConversation])

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
            } else if (route !== 'translate') {
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
            if (clipboardImage !== null) {
              setClipboardImage(null)
            } else {
              void clearClipboard()
            }
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

  // v0.3.3 批次5 收图入口：粘贴图片 → 规范化为内核附件载荷（单张，后贴覆盖前贴）。
  const handlePasteImage = useCallback(async (items: DataTransferItemList) => {
    const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'))
    if (imageItem === undefined) return
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const file = imageItem.getAsFile()
        if (file !== null) {
          resolve(file)
        } else {
          reject(new Error('clipboard image unavailable'))
        }
      })
      const payload = await encodeImageBlobForKernel(blob, imageItem.type.replace('/', '.'))
      setClipboardImage(payload)
      window.toast.success(t('miniwindow.image.attached'))
    } catch (error) {
      logger.warn('Failed to attach pasted image:', error as Error)
      window.toast.error(t('miniwindow.image.attach_failed'))
    }
  }, [t])

  // 全局粘贴监听（小窗无输入框聚焦时也能收图；文本粘贴不受影响）。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (items === undefined || items.length === 0) return
      const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'))
      if (hasImage) {
        event.preventDefault()
        void handlePasteImage(items)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [handlePasteImage])

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

        // v0.3.3-2：粘贴的图片同时进消息块（否则只在 images 载荷里给模型看，会话里不显示）。
        const imageBlocks =
          clipboardImage !== null
            ? [
                createImageBlock(userMessage.id, {
                  url: `data:${clipboardImage.mediaType};base64,${clipboardImage.data}`
                })
              ]
            : []
        const userMessageWithImages =
          imageBlocks.length > 0
            ? { ...userMessage, blocks: [...userMessage.blocks, ...imageBlocks.map((block) => block.id)] }
            : userMessage

        store.dispatch(newMessagesActions.addMessage({ topicId, message: userMessageWithImages }))
        store.dispatch(upsertManyBlocks([...blocks, ...imageBlocks]))

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
        setClipboardImage(null)

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

        // 思考（reasoning）流：懒建思考块并合入消息块列表，结束后置 SUCCESS
        let thinkingText = ''
        let thinkingBlockId: string | undefined
        let thinkingRafId = 0
        const flushThinking = () => {
          if (thinkingBlockId !== undefined) {
            store.dispatch(updateOneBlock({ id: thinkingBlockId, changes: { content: thinkingText } }))
          }
        }
        const ensureThinkingBlock = () => {
          if (thinkingBlockId !== undefined) return thinkingBlockId
          const block = createThinkingBlock(assistantMessage.id, '', { status: MessageBlockStatus.STREAMING })
          thinkingBlockId = block.id
          store.dispatch(upsertManyBlocks([block]))
          store.dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: assistantMessage.id,
              updates: { blocks: [block.id, replyBlock.id] }
            })
          )
          return block.id
        }
        const finalizeThinking = () => {
          if (thinkingRafId !== 0) {
            cancelAnimationFrame(thinkingRafId)
            thinkingRafId = 0
          }
          if (thinkingBlockId !== undefined) {
            flushThinking()
            store.dispatch(updateOneBlock({ id: thinkingBlockId, changes: { status: MessageBlockStatus.SUCCESS } }))
          }
        }
        const cancelThinking = () => {
          if (thinkingRafId !== 0) {
            cancelAnimationFrame(thinkingRafId)
            thinkingRafId = 0
          }
          if (thinkingBlockId !== undefined) {
            store.dispatch(updateOneBlock({ id: thinkingBlockId, changes: { status: MessageBlockStatus.SUCCESS } }))
          }
        }

        const reasoningEffort = kernelReasoningLevelFor(model, quickAssistantReasoningEffort)

        // 收尾（幂等，v0.3.3-1）：本轮的终态**只处理一次**——事件先到就用事件的结论，事件没到就由
        // Promise 落地兜底。看到的现象是"正文已输出完、消息仍 processing、块仍 streaming、"按 ESC
        // 暂停"一直挂着"：终态事件与 invoke 回复走两条通道会赛跑，末条 done 有概率输掉（见 preload
        // `dshStreamComplete` 的宽限期修复）。以"通道结束 = 本轮结束"为准收尾，UI 就一定能停下来。
        let terminalHandled = false
        const stopLoading = () => {
          setIsLoading(false)
          setIsOutputted(true)
          currentAskId.current = ''
        }
        const finishSuccess = () => {
          if (terminalHandled) return
          terminalHandled = true
          if (rafId !== 0) {
            cancelAnimationFrame(rafId)
            rafId = 0
          }
          flushText()
          finalizeThinking()
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
          stopLoading()
        }
        const finishError = (message?: string) => {
          if (terminalHandled) return
          terminalHandled = true
          if (rafId !== 0) {
            cancelAnimationFrame(rafId)
            rafId = 0
          }
          cancelThinking()
          store.dispatch(updateOneBlock({ id: replyBlock.id, changes: { status: MessageBlockStatus.ERROR } }))
          store.dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId: assistantMessage.id,
              updates: { status: AssistantMessageStatus.ERROR }
            })
          )
          stopLoading()
          if (message) setError(message)
        }

        await lightStream(
          assistantMessage.id,
          {
            provider: model.provider,
            model: model.id,
            system: system || undefined,
            messages: context,
            reasoningEffort,
            // v0.3.3 批次5：随触发消息上行的图片（粘贴收图；主聊天同语义——附最后一条 user）
            ...(clipboardImage !== null
              ? {
                  images: [
                    {
                      mediaType: clipboardImage.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
                      data: clipboardImage.data,
                      ...(clipboardImage.name !== undefined ? { name: clipboardImage.name } : {})
                    }
                  ]
                }
              : {}),
            source: 'cherry-quick-assistant'
          },
          (event) => {
            if (cancelledRef.current) return
            if (event.type === 'delta') {
              streamedText += event.text
              if (rafId === 0) {
                rafId = requestAnimationFrame(() => {
                  rafId = 0
                  flushText()
                })
              }
            } else if (event.type === 'reasoning-delta') {
              ensureThinkingBlock()
              thinkingText += event.text
              if (thinkingRafId === 0) {
                thinkingRafId = requestAnimationFrame(() => {
                  thinkingRafId = 0
                  flushThinking()
                })
              }
            } else if (event.type === 'done') {
              finishSuccess()
            } else if (event.type === 'error') {
              finishError(event.message || 'An error occurred')
            }
          }
        )
        // 通道已结束：终态事件没到也要收尾（用户暂停时由 handlePause 收，故这里跳过）。
        if (!cancelledRef.current) {
          finishSuccess()
        }
      } catch (err) {
        if (cancelledRef.current) {
          return
        }
        handleError(err instanceof Error ? err : new Error('An error occurred'))
        logger.error('Quick assistant error:', err as Error)
      }
    },
    [userContent, currentAssistant, quickAssistantReasoningEffort, clipboardImage]
  )

  const handlePause = useCallback(() => {
    cancelledRef.current = true
    const requestUser = currentAskId.current
    const topicId = currentTopic.current?.id
    if (topicId && requestUser) {
      const state = store.getState()
      const messageIds = state.messages.messageIdsByTopic[topicId] ?? []
      const pending = messageIds
        .map((id) => state.messages.entities[id])
        .find((m) => m !== undefined && m.role === 'assistant' && (m.askId === requestUser || m.id === requestUser))
      if (pending) {
        // fork 缝：「暂停」额外发起真取消——在途流的 requestId 就是该助手消息 id
        //（见下方 lightStream(assistantMessage.id, …)），主进程随即 abort 底层请求；
        // UI 行为不变：块/消息照旧置 PAUSED，已生成内容保留。
        void lightStreamAbort(pending.id)
        // 保留内容，仅把流式中的块与消息置为 PAUSED，停掉“该条消息下”的生成中动画
        for (const blockId of pending.blocks ?? []) {
          const block = state.messageBlocks.entities[blockId]
          if (
            block !== undefined &&
            (block.status === MessageBlockStatus.STREAMING ||
              block.status === MessageBlockStatus.PENDING ||
              block.status === MessageBlockStatus.PROCESSING)
          ) {
            store.dispatch(updateOneBlock({ id: blockId, changes: { status: MessageBlockStatus.PAUSED } }))
          }
        }
        store.dispatch(
          newMessagesActions.updateMessage({
            topicId,
            messageId: pending.id,
            updates: { status: AssistantMessageStatus.PAUSED }
          })
        )
      }
    }
    // 无条件收敛 Footer/聊天区加载动画
    setIsLoading(false)
    setIsOutputted(true)
    currentAskId.current = ''
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
  }, [isLoading, route, handleCloseWindow, handlePause])

  const handleCopy = useCallback(() => {
    // 翻译路由没有话题（译文由 TranslateWindow 自己持有并上报）：复制译文，而不是"最后一条助手消息"。
    if (route === 'translate') {
      if (!translateResult) return
      void navigator.clipboard.writeText(translateResult)
      window.toast.success(t('message.copy.success'))
      return
    }

    if (!currentTopic.current) return

    const messages = selectMessagesForTopic(store.getState(), currentTopic.current.id)
    const lastMessage = last(messages)

    if (lastMessage) {
      const content = getMainTextContent(lastMessage)
      void navigator.clipboard.writeText(content)
      window.toast.success(t('message.copy.success'))
    }
  }, [currentTopic, route, t, translateResult])

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

  /** v0.3.3 批次5：粘贴图片预览条（有图才渲染；Backspace/发送后清除）。 */
  const imagePreview = clipboardImage !== null
    ? (
      <ImagePreviewRow>
        <ImageThumb src={`data:${clipboardImage.mediaType};base64,${clipboardImage.data}`} alt="" />
        <ImagePreviewName>{clipboardImage.name ?? t('miniwindow.image.attached')}</ImagePreviewName>
        <ImagePreviewRemove
          onClick={() => {
            setClipboardImage(null)
            focusInput()
          }}
          className="nodrag">
          ×
        </ImagePreviewRemove>
      </ImagePreviewRow>
    )
    : null

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
    case 'translate':
      return (
        <Container style={{ backgroundColor }} $draggable={draggable}>
          <ClipboardPreview referenceText={referenceText} clearClipboard={clearClipboard} t={t} />
          <TranslateWindow text={userContent} onResultChange={setTranslateResult} />
          <Divider style={{ margin: '10px 0' }} />
          <Footer key="footer" {...baseFooterProps} onCopy={handleCopy} />
        </Container>
      )

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
              {imagePreview}
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
          {imagePreview}
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

const ImagePreviewRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  background-color: var(--color-background-opacity);
  border-radius: 8px;
  -webkit-app-region: none;
`

const ImageThumb = styled.img`
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
`

const ImagePreviewName = styled.span`
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ImagePreviewRemove = styled.button`
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  flex-shrink: 0;

  &:hover {
    color: var(--color-text);
  }
`

export default HomeWindow
