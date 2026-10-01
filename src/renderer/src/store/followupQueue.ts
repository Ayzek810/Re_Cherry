/**
 * 追问队列（V2 QueuedFollowupsDock 同构裁剪）：生成中的输入不再被发送键
 * 锁死——内核聊天话题在回合进行中提交的纯文本消息进本队列，回合成功结束后由
 * services/followupQueue.ts 的泵自动按序发出（V2 的 steer=插入当前轮需要内核
 * mid-turn 注入缝，fork 暂无，先行排队自动发）。
 *
 * 状态是**会话级临时态**：不持久化（store/index.ts blacklist 追加本切片，免迁移
 * 负担——重启后未发出的追问随会话消失，与 V2 行为一致）。文件级附件不入队：
 * 上传/预览与发送强耦合，纯文本先行（注释见 Inputbar 拦截点）。
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface FollowupItem {
  id: string
  text: string
  createdAt: string
}

export interface FollowupTopicQueue {
  items: FollowupItem[]
  /** 暂停自动发送：回合结束后不泵，等用户手动恢复或逐条发。 */
  paused: boolean
}

export interface FollowupQueueState {
  byTopic: Record<string, FollowupTopicQueue>
}

const initialState: FollowupQueueState = { byTopic: {} }

const emptyQueue = (): FollowupTopicQueue => ({ items: [], paused: false })

const followupQueueSlice = createSlice({
  name: 'followupQueue',
  initialState,
  reducers: {
    enqueueFollowup(state, action: PayloadAction<{ topicId: string; text: string }>) {
      const queue = state.byTopic[action.payload.topicId] ?? emptyQueue()
      queue.items.push({
        id: `fq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: action.payload.text,
        createdAt: new Date().toISOString()
      })
      state.byTopic[action.payload.topicId] = queue
    },
    removeFollowup(state, action: PayloadAction<{ topicId: string; id: string }>) {
      const queue = state.byTopic[action.payload.topicId]
      if (queue === undefined) return
      queue.items = queue.items.filter((item) => item.id !== action.payload.id)
    },
    /**
     * 把一条追问放回**队首原位**。
     *
     * 限流或发送失败时，旧实现是 `removeFollowup` + `enqueueFollowup`：那会把队首推到队尾、
     * 并重铸 `id`/`createdAt`——用户看到的队列顺序静默改变，任何按 id 定位的 UI（编辑/删除
     * 某条）随之失配。这里原样 `unshift` 同一个对象，保 id、保顺序；重复回队是幂等的
     * （同 id 已在队列里就只挪回队首，不产生副本）。
     */
    requeueFollowupHead(state, action: PayloadAction<{ topicId: string; item: FollowupItem }>) {
      const queue = state.byTopic[action.payload.topicId] ?? emptyQueue()
      const { item } = action.payload
      queue.items = [item, ...queue.items.filter((existing) => existing.id !== item.id)]
      state.byTopic[action.payload.topicId] = queue
    },
    /** 编辑 = 移出队列交还输入框（V2 语义）；此处只负责删，文本由调用方带回。 */
    setFollowupPaused(state, action: PayloadAction<{ topicId: string; paused: boolean }>) {
      const queue = state.byTopic[action.payload.topicId] ?? emptyQueue()
      queue.paused = action.payload.paused
      state.byTopic[action.payload.topicId] = queue
    },
    clearFollowupsForTopic(state, action: PayloadAction<{ topicId: string }>) {
      delete state.byTopic[action.payload.topicId]
    }
  }
})

export const { enqueueFollowup, removeFollowup, requeueFollowupHead, setFollowupPaused, clearFollowupsForTopic } =
  followupQueueSlice.actions

export const selectFollowupQueue = (
  state: { followupQueue?: FollowupQueueState },
  topicId: string
): FollowupTopicQueue => state.followupQueue?.byTopic[topicId] ?? emptyQueue()

export default followupQueueSlice.reducer
