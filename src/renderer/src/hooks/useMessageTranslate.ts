/**
 * 消息级原地翻译的 React 缝（services/messageTranslate.ts 的 hook 面）。
 *
 * - useMessageTranslationStatus：menubar 按钮态。翻译态只订阅**本消息**翻译块的 status
 *   原语（流式期间 content 变化不触发本组件重渲染——对照 inspect-data 的"别订阅全量块实体"教训）。
 * - useTranslationHydration：重投影水合。messageBlocks 切片不持久化（persist blacklist）且
 *   译文不入内核日志，应用重启/整表重投影后翻译块丢失；此钩子按 messageId 从 Dexie
 *   message_translations 复原附加块（渲染层旁路的本地增强，恢复的是展示不是会话状态）。
 */
import { loggerService } from '@logger'
import { BUILTIN_TRANSLATE_LANGUAGES, type TranslateLanguage } from '@renderer/config/translateLanguages'
import { db } from '@renderer/databases'
import store, { type RootState, useAppDispatch, useAppSelector } from '@renderer/store'
import { upsertOneBlock } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createTranslationBlock } from '@renderer/utils/messageUtils/create'
import { findTranslationBlocks } from '@renderer/utils/messageUtils/find'
import { useEffect, useMemo } from 'react'

const logger = loggerService.withContext('UseMessageTranslate')

export interface MessageTranslationStatus {
  isTranslating: boolean
  hasTranslationBlocks: boolean
}

/** menubar 翻译按钮的状态面（isTranslating 原语级订阅 + hasTranslationBlocks 随消息实体刷新）。 */
export function useMessageTranslationStatus(message: Message): MessageTranslationStatus {
  const translationStatus = useAppSelector((state: RootState) => {
    for (const blockId of message.blocks) {
      const block = state.messageBlocks.entities[blockId]
      if (block && block.type === MessageBlockType.TRANSLATION) {
        return block.status
      }
    }
    return undefined
  })

  // 上游同构 memo（[message]）：消息实体身份随 blocks 变化刷新，菜单展开时读到即当前值
  const hasTranslationBlocks = useMemo(() => findTranslationBlocks(message).length > 0, [message])

  return {
    isTranslating:
      translationStatus === MessageBlockStatus.STREAMING || translationStatus === MessageBlockStatus.PROCESSING,
    hasTranslationBlocks
  }
}

/** 内置语言表（fork 无自定义语言表，V1 的 useTranslate().translateLanguages 的 fork 等价物）。 */
export function useTranslateLanguages(): TranslateLanguage[] {
  return BUILTIN_TRANSLATE_LANGUAGES
}

/**
 * 重投影水合：消息无翻译块而 Dexie 有持久行时，复原一个 SUCCESS 翻译块挂到消息尾部。
 * 双检防竞态（等待 Dexie 期间重译可能已建块）；重复水合幂等（早退于"已有翻译块"）。
 */
export function useTranslationHydration(message: Message): void {
  const dispatch = useAppDispatch()
  const messageId = message.id
  const blockIds = message.blocks
  // 内容键：同一批 block id 的数组引用每次 updateMessage 都会换新，用它做依赖避免无谓重跑
  const blockIdsKey = (blockIds ?? []).join('\u0000')

  useEffect(() => {
    if (store_hasTranslationBlock(blockIds)) return

    let cancelled = false
    void (async () => {
      try {
        const record = await db.message_translations.get(messageId)
        if (cancelled || !record || record.content.trim().length === 0) return

        // 双检必须读**实时** store：等待 Dexie 期间在途流/重译可能已建块，
        // 而闭包里的 blockIds 是旧快照（新块 id 不在其中），旧实现会把
        // 「已有翻译块」漏检成「无块」→ 水合再建一个重复翻译块。
        const currentMessage = store_currentMessage(messageId)
        if (!currentMessage) return
        if (store_hasTranslationBlock(currentMessage.blocks)) return

        const block = createTranslationBlock(messageId, record.content, record.targetLanguage, {
          status: MessageBlockStatus.SUCCESS,
          createdAt: record.updatedAt
        })
        dispatch(upsertOneBlock(block))
        dispatch(
          newMessagesActions.updateMessage({
            topicId: currentMessage.topicId,
            messageId,
            updates: { blockInstruction: { id: block.id } }
          })
        )
      } catch (error) {
        logger.warn('translation hydration failed', error as Error)
      }
    })()

    return () => {
      cancelled = true
    }
    // f2-11 / X4：依赖数组的引用会随每次 blockInstruction 更新而失效，改按内容键收口
  }, [dispatch, messageId, blockIdsKey])
}

// ---- 水合内部的小读面（独立函数便于测试桩注入点的一致性；非导出 API） ----

function store_hasTranslationBlock(blockIds: Message['blocks']): boolean {
  const state = store.getState()
  return (blockIds ?? []).some(
    (blockId) => state.messageBlocks.entities[blockId]?.type === MessageBlockType.TRANSLATION
  )
}

function store_currentMessage(messageId: string): Message | undefined {
  return store.getState().messages.entities[messageId]
}
