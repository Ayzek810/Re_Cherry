import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  maybeProcessConversationMemory,
  parseFactsFromResponse,
  parseMemoryOpsFromResponse
} from '../memoryProcessor'

/**
 * 全局记忆抽取管线（services/memoryProcessor.ts，v0.4.7）的单测。
 *
 * 钉四件事：
 *   ① 事实解析：容忍 ```json 围栏/前后缀文本、{"facts":[...]} 与裸数组两形态、
 *      非字符串过滤、空串过滤、20 条/500 字上限、非法 JSON → 空数组（不抛）；
 *   ② 差分解析：裸数组与 {"memory":[...]} 两形态、非法 event/无 id 的 UPDATE·DELETE 丢弃；
 *   ③ 门逻辑：全局开关关 / enableMemory 关 / 未配置记忆模型 / 缺正文 → 不调模型不落库；
 *   ④ 差分动作：无既有记忆 → 全 ADD；有既有记忆 → 走 LLM 差分并按 op 落库
 *      （ADD/UPDATE/DELETE），单条失败不影响其余。
 *
 * store / newMessage / ApiService / MemoryService / find 全部桩注入（topicNaming.test 同模式）。
 */
let assistantsState: Array<Record<string, unknown>> = []
let messagesState: Array<Record<string, unknown>> = []
let globalMemoryEnabled = true
let memoryConfigState: { llmModel?: unknown; customFactExtractionPrompt?: string; customUpdateMemoryPrompt?: string } = {
  llmModel: { id: 'memory-model', provider: 'openai' }
}
let findBlocks: (message: unknown) => Array<{ content: string }> = (message) =>
  ((message as { blocks?: Array<{ content: string }> }).blocks ?? [])

const { fetchGenerateApi } = vi.hoisted(() => ({ fetchGenerateApi: vi.fn() }))
const { memoryApi } = vi.hoisted(() => ({
  memoryApi: { search: vi.fn(), add: vi.fn(), update: vi.fn(), delete: vi.fn() }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      assistants: { assistants: assistantsState }
    })
  }
}))

vi.mock('@renderer/store/memory', () => ({
  selectGlobalMemoryEnabled: () => globalMemoryEnabled,
  selectMemoryConfig: () => memoryConfigState
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: () => messagesState
}))

vi.mock('@renderer/services/ApiService', () => ({
  fetchGenerate: fetchGenerateApi
}))

vi.mock('@renderer/services/MemoryService', () => ({
  default: { getInstance: () => memoryApi }
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findMainTextBlocks: (message: unknown) => findBlocks(message)
}))

function messageWith(text: string, role: 'user' | 'assistant' = 'user'): Record<string, unknown> {
  return { id: text, role, blocks: [{ content: text }] }
}

function assistantRow(enableMemory: boolean): Record<string, unknown> {
  return {
    id: 'assistant-1',
    enableMemory,
    topics: [{ id: 'topic-a', assistantId: 'assistant-1' }]
  }
}

beforeEach(() => {
  assistantsState = [assistantRow(true)]
  messagesState = [messageWith('我叫小陈，用 TypeScript', 'user'), messageWith('好的，记下了', 'assistant')]
  globalMemoryEnabled = true
  memoryConfigState = { llmModel: { id: 'memory-model', provider: 'openai' } }
  findBlocks = (message) => ((message as { blocks?: Array<{ content: string }> }).blocks ?? [])
  fetchGenerateApi.mockReset()
  memoryApi.search.mockReset().mockResolvedValue({ results: [] })
  memoryApi.add.mockReset().mockResolvedValue({ results: [] })
  memoryApi.update.mockReset()
  memoryApi.delete.mockReset()
})

describe('parseFactsFromResponse（事实解析）', () => {
  it('标准 {"facts":[...]} 直取', () => {
    expect(parseFactsFromResponse('{"facts": ["Name is John", "Is an engineer"]}')).toEqual([
      'Name is John',
      'Is an engineer'
    ])
  })

  it('裸数组也接受（V1 jaison 兼容形态）', () => {
    expect(parseFactsFromResponse('["Favourite movies: Inception"]')).toEqual(['Favourite movies: Inception'])
  })

  it('```json 围栏与前后缀文本容忍', () => {
    const response = 'Sure! Here you go:\n```json\n{"facts": ["Likes tea"]}\n```\nHope that helps.'
    expect(parseFactsFromResponse(response)).toEqual(['Likes tea'])
  })

  it('非法 JSON / 无 JSON → 空数组不抛', () => {
    expect(parseFactsFromResponse('no json here')).toEqual([])
    expect(parseFactsFromResponse('{"facts": "not-an-array"}')).toEqual([])
  })

  it('非字符串与空白项过滤 + 数量/长度上限', () => {
    const facts = Array.from({ length: 30 }, (_, i) => `fact-${i}`)
    facts.unshift('', '   ', 42 as unknown as string)
    const parsed = parseFactsFromResponse(JSON.stringify({ facts }))
    expect(parsed).toHaveLength(20)
    expect(parsed[0]).toBe('fact-0')
    const long = parseFactsFromResponse(JSON.stringify({ facts: ['x'.repeat(600)] }))
    expect(long[0]).toHaveLength(500)
  })
})

describe('parseMemoryOpsFromResponse（差分解析）', () => {
  it('裸数组与 {"memory":[...]} 两形态都接受', () => {
    const op = '{"event":"ADD","id":"","text":"Likes tea"}'
    expect(parseMemoryOpsFromResponse(`[${op}]`)).toHaveLength(1)
    expect(parseMemoryOpsFromResponse(`{"memory": [${op}]}`)).toHaveLength(1)
  })

  it('非法 event / 缺 text / UPDATE·DELETE 缺 id → 条目丢弃', () => {
    const ops = parseMemoryOpsFromResponse(
      JSON.stringify([
        { event: 'REPLACE', id: '1', text: 'x' },
        { event: 'ADD', text: 'no-id-add' },
        { event: 'UPDATE', text: 'missing id' },
        { event: 'DELETE', id: 'm-1', text: 'gone' },
        { event: 'NONE', id: 'm-2', text: 'unchanged' }
      ])
    )
    expect(ops.map((op) => op.event)).toEqual(['ADD', 'DELETE', 'NONE'])
  })
})

describe('maybeProcessConversationMemory（门 + 差分动作）', () => {
  it('全局开关关 → 不调模型不落库', async () => {
    globalMemoryEnabled = false
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).not.toHaveBeenCalled()
    expect(memoryApi.add).not.toHaveBeenCalled()
  })

  it('enableMemory 关 → 不调模型不落库', async () => {
    assistantsState = [assistantRow(false)]
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).not.toHaveBeenCalled()
  })

  it('未配置记忆模型 → 不调模型不落库', async () => {
    memoryConfigState = {}
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).not.toHaveBeenCalled()
  })

  it('助手正文缺失 → 不调模型不落库', async () => {
    messagesState = [messageWith('只有用户说话')]
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).not.toHaveBeenCalled()
  })

  it('门全过 + 无既有记忆 → 抽取后全 ADD', async () => {
    fetchGenerateApi.mockResolvedValue('```json\n{"facts": ["User is 小陈", "Prefers TypeScript"]}\n```')
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).toHaveBeenCalledTimes(1)
    expect(memoryApi.add).toHaveBeenCalledTimes(2)
    expect(memoryApi.add).toHaveBeenCalledWith('User is 小陈', { agentId: 'assistant-1' })
    expect(memoryApi.update).not.toHaveBeenCalled()
  })

  it('有既有记忆 → LLM 差分，ADD/UPDATE/DELETE 各落其位；单条失败不阻断', async () => {
    memoryApi.search.mockResolvedValue({
      results: [
        { id: 'm-1', memory: 'User likes coffee' },
        { id: 'm-2', memory: 'User is in Shanghai' }
      ]
    })
    fetchGenerateApi
      .mockResolvedValueOnce('{"facts": ["User loves tea", "User moved to Beijing"]}')
      .mockResolvedValueOnce(
        JSON.stringify([
          { event: 'UPDATE', id: 'm-1', text: 'User loves tea', old_memory: 'User likes coffee' },
          { event: 'DELETE', id: 'm-2', text: 'User moved to Beijing' },
          { event: 'ADD', text: 'User loves tea again' },
          { event: 'NONE', id: 'm-1', text: 'unchanged' }
        ])
      )
    memoryApi.update.mockRejectedValueOnce(new Error('db busy'))
    await maybeProcessConversationMemory('topic-a')
    expect(fetchGenerateApi).toHaveBeenCalledTimes(2)
    expect(memoryApi.update).toHaveBeenCalledWith('m-1', 'User loves tea', expect.anything())
    expect(memoryApi.delete).toHaveBeenCalledWith('m-2')
    expect(memoryApi.add).toHaveBeenCalledWith('User loves tea again', { agentId: 'assistant-1' })
  })

  it('抽取为空 → 不进差分、不落库', async () => {
    fetchGenerateApi.mockResolvedValue('{"facts": []}')
    await maybeProcessConversationMemory('topic-a')
    expect(memoryApi.add).not.toHaveBeenCalled()
    expect(fetchGenerateApi).toHaveBeenCalledTimes(1)
  })
})
