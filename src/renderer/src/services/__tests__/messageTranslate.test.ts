import type { TranslateLanguage } from '@renderer/config/translateLanguages'
import type { Message, MessageBlock, TranslationMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 消息级原地翻译（services/messageTranslate.ts）触发逻辑单测。
 *
 * 钉八件事：
 *   ① 三道门（翻译中/空文本/无翻译模型）→ 不发流、无副作用；
 *   ② 无块首译：创建 STREAMING 翻译块 + blockInstruction 挂到消息尾部；
 *   ③ 已有块重译：原地重置（清空 + STREAMING + 新目标语言），不新建块（上游 getTranslationUpdater 语义）；
 *   ④ 流式增量节流落块，终态 SUCCESS；Dexie 镜像同步写；
 *   ⑤ 流错误：非空保留已生成部分、空块清理（removeBlocksThunk + Dexie 删行）+ 用户可见 toast；
 *   ⑥ 用户停止：abort 走 lightStreamAbort，部分结果保留、不报错 toast（上游 abort 语义）；
 *   ⑦ 关闭译文：块 + 持久行一起删；
 *   ⑧ 复制译文：拼接内容写剪贴板，空译文给 warning。
 *
 * store / lightLlm / databases / i18n / 块 thunk 全部桩注入（对照 topicNaming.test.ts 模式）；
 * createTranslationBlock 用真实工厂（钉真块形状）。
 */
const { dispatchMock, lightStreamMock, lightStreamAbortMock, translationTable } = vi.hoisted(() => ({
  dispatchMock: vi.fn(async (action: unknown) => action),
  lightStreamMock: vi.fn(),
  lightStreamAbortMock: vi.fn(async () => undefined),
  translationTable: {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined)
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => testState,
    dispatch: dispatchMock
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    updateMessage: (payload: unknown) => ({ type: 'messages/updateMessage', payload })
  }
}))

vi.mock('@renderer/store/messageBlock', () => ({
  updateOneBlock: (payload: unknown) => ({ type: 'messageBlocks/updateOneBlock', payload }),
  upsertOneBlock: (payload: unknown) => ({ type: 'messageBlocks/upsertOneBlock', payload })
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  removeBlocksThunk: (topicId: string, messageId: string, blockIds: string[]) => ({
    type: 'messageThunk/removeBlocksThunk',
    payload: { topicId, messageId, blockIds }
  })
}))

vi.mock('@renderer/services/lightLlm', () => ({
  lightStream: lightStreamMock,
  lightStreamAbort: lightStreamAbortMock
}))

vi.mock('@renderer/databases', () => ({
  db: { message_translations: translationTable }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import { abortMessageTranslation, closeMessageTranslation, copyMessageTranslation, startMessageTranslation } from '../messageTranslate'

type TestState = {
  messages: { entities: Record<string, Message> }
  messageBlocks: { entities: Record<string, MessageBlock> }
  llm: { translateModel: { id: string; provider: string; name: string } | undefined }
}

let testState: TestState
let dispatched: Array<Record<string, unknown>>
let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
const writeTextMock = vi.fn(async () => undefined)

const MODEL = { id: 'model-1', provider: 'provider-1', name: 'Test Model' }
const LANGUAGE_ZH: TranslateLanguage = { langCode: 'zh-cn', value: 'Chinese (Simplified)', emoji: '🇨🇳' }

function buildMessage(blockIds: string[]): Message {
  return {
    id: 'm1',
    role: 'assistant',
    assistantId: 'a1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: blockIds
  }
}

function buildState(opts: {
  messageBlocks?: MessageBlock[]
  messageBlockIds?: string[]
  translateModel?: TestState['llm']['translateModel']
}): TestState {
  const message = buildMessage(opts.messageBlockIds ?? ['b-main'])
  const entities: Record<string, MessageBlock> = {
    'b-main': {
      id: 'b-main',
      messageId: 'm1',
      type: MessageBlockType.MAIN_TEXT,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: MessageBlockStatus.SUCCESS,
      content: 'Hello world'
    }
  }
  for (const block of opts.messageBlocks ?? []) {
    entities[block.id] = block
  }
  return {
    messages: { entities: { [message.id]: message } },
    messageBlocks: { entities },
    llm: { translateModel: 'translateModel' in opts ? opts.translateModel : MODEL }
  }
}

function translationBlock(overrides: Partial<TranslationMessageBlock> = {}): TranslationMessageBlock {
  return {
    id: 'b-tr',
    messageId: 'm1',
    type: MessageBlockType.TRANSLATION,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: MessageBlockStatus.SUCCESS,
    content: 'old translation',
    targetLanguage: 'en-us',
    ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  dispatched = []
  // 迷你 reducer：把服务用到的 action 语义真实应用到 testState（upsert/update 挂块、
  // blockInstruction 追加、removeBlocksThunk 清块）——清理路径要按更新后的 blocks 找块。
  dispatchMock.mockImplementation(async (action: unknown) => {
    const a = action as { type?: string; payload?: Record<string, unknown> }
    dispatched.push(a)
    const payload = a?.payload
    if (a?.type === 'messageBlocks/upsertOneBlock' && payload) {
      // 浅拷贝入表：后续 updateOneBlock 的 Object.assign 不得污染 dispatched 里的建块载荷
      testState.messageBlocks.entities[payload.id as string] = { ...(payload as unknown as MessageBlock) }
    } else if (a?.type === 'messageBlocks/updateOneBlock' && payload) {
      const entity = testState.messageBlocks.entities[payload.id as string]
      if (entity) Object.assign(entity, payload.changes as object)
    } else if (a?.type === 'messages/updateMessage' && payload) {
      const message = testState.messages.entities[payload.messageId as string]
      const instruction = (payload.updates as { blockInstruction?: { id: string } })?.blockInstruction
      if (message && instruction && !message.blocks.includes(instruction.id)) {
        message.blocks = [...message.blocks, instruction.id]
      }
    } else if (a?.type === 'messageThunk/removeBlocksThunk' && payload) {
      const messageId = payload.messageId as string
      const blockIds = payload.blockIds as string[]
      const message = testState.messages.entities[messageId]
      if (message) message.blocks = message.blocks.filter((id) => !blockIds.includes(id))
      for (const id of blockIds) {
        delete testState.messageBlocks.entities[id]
      }
    }
    return action
  })
  lightStreamMock.mockReset()
  lightStreamAbortMock.mockClear()
  translationTable.put.mockClear()
  translationTable.delete.mockClear()
  writeTextMock.mockClear()
  toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
  ;(window as unknown as { toast: unknown }).toast = toast
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

/** 流 mock：按序回放事件后 resolve（onAbortHook 在事件序列中点插入测试自定义动作）。 */
function playStream(events: Array<Record<string, unknown>>, onAbortHook?: () => void): void {
  lightStreamMock.mockImplementation(async (_requestId: string, _call: unknown, onEvent: (e: unknown) => void) => {
    for (const event of events) {
      if (event.__abortHook === true) {
        onAbortHook?.()
        continue
      }
      onEvent(event)
    }
    return { ok: true }
  })
}

describe('门（翻译中 / 空文本 / 无模型）', () => {
  it('已在翻译中（块 STREAMING）→ 直接忽略，不发流', async () => {
    testState = buildState({ messageBlocks: [translationBlock({ status: MessageBlockStatus.STREAMING })], messageBlockIds: ['b-main', 'b-tr'] })
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(lightStreamMock).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(0)
  })

  it('源文本为空 → error.empty，不发流', async () => {
    testState = buildState({})
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: '   ', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('translate.error.empty')
    expect(lightStreamMock).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(0)
  })

  it('未配置翻译模型 → error.not_configured，不发流（与翻译页同一道门）', async () => {
    testState = buildState({ translateModel: undefined })
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('translate.error.not_configured')
    expect(lightStreamMock).not.toHaveBeenCalled()
  })
})

describe('建块与重译（上游 getTranslationUpdater 语义）', () => {
  it('无块首译：创建 STREAMING 翻译块 + blockInstruction 挂消息尾；流式增量落块、终态 SUCCESS', async () => {
    testState = buildState({})
    playStream([
      { type: 'delta', text: '你好，' },
      { type: 'delta', text: '世界' },
      { type: 'done' }
    ])
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(true)
    // 流参数：requestId 配对、轻通路 source、提示词带目标语言与源文本
    expect(lightStreamMock).toHaveBeenCalledTimes(1)
    const [requestId, call] = lightStreamMock.mock.calls[0] as [string, { messages: Array<{ text: string }>; source: string }]
    expect(requestId).toBe('message-translate:m1')
    expect(call.source).toBe('cherry-translate')
    expect(call.messages[0].text).toContain('languages.chinese')
    expect(call.messages[0].text).toContain('Hello world')

    // 建块：upsert 翻译块（真实工厂形状）+ blockInstruction 挂到消息
    const upsert = dispatched.find((action) => action.type === 'messageBlocks/upsertOneBlock')
    expect(upsert).toBeDefined()
    const created = (upsert as { payload: TranslationMessageBlock }).payload
    expect(created.type).toBe(MessageBlockType.TRANSLATION)
    expect(created.status).toBe(MessageBlockStatus.STREAMING)
    expect(created.targetLanguage).toBe('zh-cn')
    expect(created.messageId).toBe('m1')
    expect(dispatched).toContainEqual({
      type: 'messages/updateMessage',
      payload: expect.objectContaining({
        topicId: 'topic-1',
        messageId: 'm1',
        updates: expect.objectContaining({ blockInstruction: { id: created.id } })
      })
    })

    // 终态：最后一次 update 是 SUCCESS + 全量内容
    const updates = dispatched.filter((action) => action.type === 'messageBlocks/updateOneBlock')
    const last = updates[updates.length - 1] as { payload: { changes: { content: string; status: MessageBlockStatus } } }
    expect(last.payload.changes.content).toBe('你好，世界')
    expect(last.payload.changes.status).toBe(MessageBlockStatus.SUCCESS)

    // Dexie 镜像：建块清零一次 + 终态一次（节流直写合并中间增量）
    expect(translationTable.put).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', content: '你好，世界', targetLanguage: 'zh-cn' }))
  })

  it('已有块重译：原地重置（清空 + STREAMING + 新目标语言），不新建块', async () => {
    testState = buildState({ messageBlocks: [translationBlock()], messageBlockIds: ['b-main', 'b-tr'] })
    playStream([{ type: 'delta', text: '新的译文' }, { type: 'done' }])
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(true)
    expect(dispatched.find((action) => action.type === 'messageBlocks/upsertOneBlock')).toBeUndefined()
    expect(dispatched).not.toContainEqual(expect.objectContaining({ type: 'messages/updateMessage' }))
    const reset = dispatched.find(
      (action) =>
        action.type === 'messageBlocks/updateOneBlock' &&
        (action.payload as { changes: { content: string } }).changes.content === ''
    )
    expect(reset).toBeDefined()
    const resetChanges = (reset as { payload: { changes: { status: MessageBlockStatus; targetLanguage: string; metadata: { targetLanguage: string } } } })
      .payload.changes
    expect(resetChanges.status).toBe(MessageBlockStatus.STREAMING)
    // 顶层与 metadata 双写（fork 修正：knowledge.ts 导出分支读顶层 targetLanguage）
    expect(resetChanges.targetLanguage).toBe('zh-cn')
    expect(resetChanges.metadata.targetLanguage).toBe('zh-cn')
    // 重译复用原块 id
    const last = dispatched.filter((action) => action.type === 'messageBlocks/updateOneBlock').pop() as {
      payload: { id: string; changes: { content: string } }
    }
    expect(last.payload.id).toBe('b-tr')
    expect(last.payload.changes.content).toBe('新的译文')
  })
})

describe('失败与中止', () => {
  it('流错误且无内容 → error.failed toast + 空块清理（removeBlocksThunk + Dexie 删行）', async () => {
    testState = buildState({})
    playStream([{ type: 'error', message: 'boom' }])
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('translate.error.failed: boom')
    expect(dispatched).toContainEqual({
      type: 'messageThunk/removeBlocksThunk',
      payload: { topicId: 'topic-1', messageId: 'm1', blockIds: [expect.any(String)] }
    })
    expect(translationTable.delete).toHaveBeenCalledWith('m1')
  })

  it('流错误但已有部分内容 → 保留已生成部分，不删块', async () => {
    testState = buildState({})
    playStream([{ type: 'delta', text: '部分' }, { type: 'error', message: 'boom' }])
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalled()
    expect(dispatched).not.toContainEqual(expect.objectContaining({ type: 'messageThunk/removeBlocksThunk' }))
  })

  it('done 但内容为空 → error.empty + 空块清理', async () => {
    testState = buildState({})
    playStream([{ type: 'done' }])
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('translate.error.empty')
    expect(dispatched).toContainEqual(expect.objectContaining({ type: 'messageThunk/removeBlocksThunk' }))
  })

  it('用户停止：lightStreamAbort 真取消 + 部分结果保留 + 不报错误 toast', async () => {
    testState = buildState({})
    playStream(
      [
        { type: 'delta', text: 'Partial ' },
        { __abortHook: true },
        { type: 'error', message: 'stream aborted' }
      ],
      () => abortMessageTranslation('m1')
    )
    const ok = await startMessageTranslation({ topicId: 'topic-1', message: testState.messages.entities['m1'], sourceText: 'Hello world', language: LANGUAGE_ZH })

    expect(ok).toBe(true)
    expect(lightStreamAbortMock).toHaveBeenCalledWith('message-translate:m1')
    expect(toast.error).not.toHaveBeenCalled()
    expect(dispatched).not.toContainEqual(expect.objectContaining({ type: 'messageThunk/removeBlocksThunk' }))
    const last = dispatched.filter((action) => action.type === 'messageBlocks/updateOneBlock').pop() as {
      payload: { changes: { content: string; status: MessageBlockStatus } }
    }
    expect(last.payload.changes.content).toBe('Partial ')
    expect(last.payload.changes.status).toBe(MessageBlockStatus.SUCCESS)
  })
})

describe('关闭与复制', () => {
  it('关闭译文：翻译块走 removeBlocksThunk + 持久行删除', async () => {
    testState = buildState({ messageBlocks: [translationBlock()], messageBlockIds: ['b-main', 'b-tr'] })
    await closeMessageTranslation('topic-1', 'm1')

    expect(dispatched).toContainEqual({
      type: 'messageThunk/removeBlocksThunk',
      payload: { topicId: 'topic-1', messageId: 'm1', blockIds: ['b-tr'] }
    })
    expect(translationTable.delete).toHaveBeenCalledWith('m1')
  })

  it('无翻译块时关闭 → 无操作', async () => {
    testState = buildState({})
    await closeMessageTranslation('topic-1', 'm1')

    expect(dispatched).toHaveLength(0)
    expect(translationTable.delete).not.toHaveBeenCalled()
  })

  it('复制译文：拼接内容写剪贴板 + success toast', async () => {
    testState = buildState({ messageBlocks: [translationBlock({ content: '  译文内容  ' })], messageBlockIds: ['b-main', 'b-tr'] })
    const ok = await copyMessageTranslation(testState.messages.entities['m1'])

    expect(ok).toBe(true)
    expect(writeTextMock).toHaveBeenCalledWith('译文内容')
    expect(toast.success).toHaveBeenCalledWith('messageTranslate.copied')
  })

  it('译文为空复制 → warning，不写剪贴板', async () => {
    testState = buildState({ messageBlocks: [translationBlock({ content: '   ' })], messageBlockIds: ['b-main', 'b-tr'] })
    const ok = await copyMessageTranslation(testState.messages.entities['m1'])

    expect(ok).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith('messageTranslate.empty')
    expect(writeTextMock).not.toHaveBeenCalled()
  })
})
