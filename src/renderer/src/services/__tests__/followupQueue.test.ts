import followupQueueReducer, {
  clearFollowupsForTopic,
  enqueueFollowup,
  removeFollowup,
  selectFollowupQueue,
  setFollowupPaused
} from '@renderer/store/followupQueue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 追问队列（v0.4.7）单测：
 *   ① 切片：入队/移除/暂停/清空/选择器缺省；
 *   ② 泵：空队列/暂停 → 不发；门全过 → 移除队首并按正常路径发送；
 *      限流命中 → 退回队尾不丢；话题行缺失 → 丢弃并记日志（不假装已发）。
 * store / MessagesService / TokenService / messageThunk 全部桩注入。
 */
let byTopicState: Record<string, { items: Array<{ id: string; text: string; createdAt: string }>; paused: boolean }> =
  {}
let assistantsState: Array<Record<string, unknown>> = []
const dispatched: Array<{ type: string; payload?: unknown }> = []

const { getUserMessageApi, checkRateLimitApi, estimateUsageApi, sendMessageThunkApi } = vi.hoisted(() => ({
  getUserMessageApi: vi.fn(),
  checkRateLimitApi: vi.fn(),
  estimateUsageApi: vi.fn(),
  sendMessageThunkApi: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      followupQueue: { byTopic: byTopicState },
      assistants: { assistants: assistantsState }
    }),
    dispatch: (action: { type: string; payload?: unknown }) => {
      dispatched.push(action)
      return action
    }
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  sendMessage: sendMessageThunkApi
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getUserMessage: getUserMessageApi,
  checkRateLimit: checkRateLimitApi
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateUserPromptUsage: estimateUsageApi
}))

function row(id: string): Record<string, unknown> {
  return { id, topics: [{ id: 'topic-a' }] }
}

function item(id: string): { id: string; text: string; createdAt: string } {
  return { id, text: `追问-${id}`, createdAt: new Date().toISOString() }
}

beforeEach(() => {
  byTopicState = {}
  assistantsState = [row('assistant-1')]
  dispatched.length = 0
  getUserMessageApi.mockReset().mockImplementation(({ content }: { content: string }) => ({
    message: { id: 'u1', content },
    blocks: []
  }))
  checkRateLimitApi.mockReset().mockReturnValue(false)
  estimateUsageApi.mockReset().mockResolvedValue(undefined)
  sendMessageThunkApi.mockReset().mockReturnValue({ type: 'message/sendMessage' })
})

describe('followupQueue 切片', () => {
  it('入队追加、移除过滤、暂停翻转、清空删除', () => {
    let state = { byTopic: {} as typeof byTopicState }
    const root = () => ({ followupQueue: state })
    state = followupQueueReducer(state, enqueueFollowup({ topicId: 't1', text: 'a' }))
    state = followupQueueReducer(state, enqueueFollowup({ topicId: 't1', text: 'b' }))
    expect(selectFollowupQueue(root(), 't1').items).toHaveLength(2)
    expect(selectFollowupQueue(root(), 'missing').items).toHaveLength(0)

    const first = selectFollowupQueue(root(), 't1').items[0]
    state = followupQueueReducer(state, removeFollowup({ topicId: 't1', id: first.id }))
    expect(selectFollowupQueue(root(), 't1').items.map((item) => item.text)).toEqual(['b'])

    state = followupQueueReducer(state, setFollowupPaused({ topicId: 't1', paused: true }))
    expect(selectFollowupQueue(root(), 't1').paused).toBe(true)

    state = followupQueueReducer(state, clearFollowupsForTopic({ topicId: 't1' }))
    expect(state.byTopic['t1']).toBeUndefined()
  })
})

describe('pumpFollowupQueue（泵）', () => {
  async function pump() {
    const { pumpFollowupQueue } = await import('@renderer/services/followupQueue')
    await pumpFollowupQueue('topic-a')
  }

  it('空队列 / 暂停 → 不发', async () => {
    await pump()
    byTopicState = { 'topic-a': { items: [item('x')], paused: true } }
    await pump()
    expect(dispatched).toHaveLength(0)
  })

  it('门全过 → 移除队首并按正常路径发送', async () => {
    byTopicState = {
      'topic-a': { items: [item('first'), item('second')], paused: false }
    }
    await pump()
    expect(dispatched.some((action) => action.type === 'followupQueue/removeFollowup')).toBe(true)
    expect(sendMessageThunkApi).toHaveBeenCalledTimes(1)
    expect(getUserMessageApi).toHaveBeenCalledWith(expect.objectContaining({ content: '追问-first' }))
  })

  it('限流命中 → 不发送也不丢（退回队列）', async () => {
    byTopicState = { 'topic-a': { items: [item('first')], paused: false } }
    checkRateLimitApi.mockReturnValue(true)
    await pump()
    expect(sendMessageThunkApi).not.toHaveBeenCalled()
    expect(dispatched.filter((action) => action.type === 'followupQueue/enqueueFollowup')).toHaveLength(1)
  })

  it('话题行缺失 → 丢弃队首（不假装已发）', async () => {
    assistantsState = []
    byTopicState = { 'topic-a': { items: [item('first')], paused: false } }
    await pump()
    expect(sendMessageThunkApi).not.toHaveBeenCalled()
    expect(dispatched.some((action) => action.type === 'followupQueue/removeFollowup')).toBe(true)
  })
})
