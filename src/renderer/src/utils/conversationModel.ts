/**
 * conversationModel —— 逻辑对话树（LCT）的纯实现。
 *
 * 背景：DSH 会话是 append-only 日志；fork 用 seed 精确复制父前缀。因此一个会话的
 * 日志里可能同时含"复制自祖先的轮"与"自己新生的轮"。为让 图/删除/重发 共享同一套
 * 语义（避免"副本容器 vs 内容出身"错位），这里把每个轮解析到 origin：
 *   origin(session, idx) = idx < shared(session) ? origin(parent(session), idx) : (session, idx)
 *
 * 关键规则：shared 只在存在活父时按事件里"最后一个" end-seed（本会话自己的种子边界，
 * fork seed 会连同祖先的 end-seed 一起拷贝）前的 user 数计算；
 * parentless 会话（普通根、以及删除截断后产生的新根）拥有其全部轮次（shared=0）。
 *
 * 本模块为纯函数 + 注入式读取，便于图（实时内核）与测试（文件/fixture）共用。
 */
/** 一条助手回复（附生成它的模型身份，供分支图头像/标签使用）。 */
export interface CMReply {
  text: string
  modelId?: string
  provider?: string
}

export interface CMUserTurn {
  text: string
  replies: CMReply[]
}

export interface CMSession {
  id: string
  name?: string
  parentTopicId?: string
  /** 与活父共享的前缀轮数（无活父 = 0）。 */
  shared: number
  turns: CMUserTurn[]
  /** 每轮 user/message 的 seq（可选；页码卡片定位用，下标与 turns 对齐）。 */
  userSeqs?: number[]
  /** 每轮有文本 assistant/message 的 seq 列表（可选；与 turns[i].replies 对齐）。 */
  replySeqs?: number[][]
}

export type CMOriginId = string // 形如 sessionId:index

/**
 * 从内核事件列表解析出 user 轮与 end-seed 前的 user 数。
 *
 * 注意：fork 的 seed 会原样拷贝父会话事件，父会话若本身是 fork 出来的，其 end-seed
 * 标记也会被拷进子会话 —— 因此多层分支的日志里通常有多个 end-seed（越靠前越是祖先的）。
 * 本会话自己的种子边界是"最后一个位于最大 user seq 之前的" end-seed：
 *   - 持久化日志在会话末尾可能带"拖尾 end-seed"（seq 大于所有 user 事件），那不代表边界；
 *   - 祖先的 end-seed 一定小于本会话边界（两者之间没有 user 事件）。
 * 因此取 max{ end-seed seq < maxUserSeq } 即本会话自己的边界；无此类时回退取最大 end-seed。
 * 取第一个会少算共享前缀，导致第一次重发之后的轮被误当成新轮重复建节点。
 */
export function parseSessionEvents(events: ReadonlyArray<{ seq: number; type: string; data?: unknown }>): {
  turns: CMUserTurn[]
  userBeforeEndSeed: number
  userSeqs: number[]
  replySeqs: number[][]
} {
  let userMaxSeq = -1
  const seedSeqs: number[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.seq > userMaxSeq) userMaxSeq = event.seq
    if (event.type === 'session/end-seed') seedSeqs.push(event.seq)
  }
  let endSeedSeq: number | undefined
  if (seedSeqs.length > 0) {
    const below = seedSeqs.filter((seq) => seq < userMaxSeq)
    endSeedSeq = below.length > 0 ? (below[below.length - 1] as number) : (seedSeqs[seedSeqs.length - 1] as number)
  }
  let userBefore = 0
  const turns: CMUserTurn[] = []
  const userSeqs: number[] = []
  const replySeqs: number[][] = []
  for (const e of events) {
    if (e.type === 'user/message') {
      if (endSeedSeq !== undefined && e.seq < endSeedSeq) userBefore += 1
      const content = (e.data as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
      turns.push({ text: textOf(content), replies: [] })
      userSeqs.push(e.seq)
      replySeqs.push([])
    } else if (e.type === 'assistant/message') {
      const message = (
        e.data as
          | {
              message?: {
                content?: Array<{ type: string; text?: string }>
                source?: { provider?: string; model?: string }
              }
            }
          | undefined
      )?.message
      const text = textOf(message?.content)
      if (turns.length > 0 && text.length > 0) {
        const source = message?.source
        turns[turns.length - 1].replies.push({
          text,
          ...(source?.model !== undefined ? { modelId: source.model } : {}),
          ...(source?.provider !== undefined ? { provider: source.provider } : {})
        })
        replySeqs[replySeqs.length - 1].push(e.seq)
      }
    }
  }
  return { turns, userBeforeEndSeed: userBefore, userSeqs, replySeqs }
}

/** 单一推导：所有消费方（图/列表/删除投影）共用同一套文本解析，杜绝各自解释。 */
export function contentText(blocks: Array<{ type: string; text?: string }> | undefined): string {
  return (blocks ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
    .map((b) => b.text as string)
    .join('\n')
}

function textOf(blocks: Array<{ type: string; text?: string }> | undefined): string {
  return contentText(blocks)
}

export interface CMFamily {
  rootId: string
  sessions: CMSession[]
  byId: Map<string, CMSession>
}

/** 用注入的读取函数加载某个根话题的家族（要求根在前、父先于子）。 */
export async function loadFamily(
  rootId: string,
  readers: {
    listBranches: (rootId: string) => Promise<Array<{ id: string; name?: string; parentTopicId?: string }>>
    sessionEvents: (id: string) => Promise<ReadonlyArray<{ seq: number; type: string; data?: unknown }>>
  }
): Promise<CMFamily> {
  const topics = await readers.listBranches(rootId)
  const sessions: CMSession[] = []
  for (const topic of topics) {
    const events = await readers.sessionEvents(topic.id)
    const { turns, userBeforeEndSeed, userSeqs, replySeqs } = parseSessionEvents(events)
    const hasLiveParent = topic.parentTopicId !== undefined && topics.some((t) => t.id === topic.parentTopicId)
    sessions.push({
      id: topic.id,
      name: topic.name,
      parentTopicId: topic.parentTopicId,
      shared: hasLiveParent ? userBeforeEndSeed : 0,
      turns,
      userSeqs,
      replySeqs
    })
  }
  return { rootId, sessions, byId: new Map(sessions.map((s) => [s.id, s])) }
}

/** origin 递归推导；悬空/越界返回 null。 */
export function originOf(family: CMFamily, sessionId: string, index: number): CMOriginId | null {
  const session = family.byId.get(sessionId)
  if (!session || index < 0 || index >= session.turns.length) return null
  if (index < session.shared) {
    const parentId = session.parentTopicId
    if (!parentId || !family.byId.has(parentId)) return null
    return originOf(family, parentId, index)
  }
  return sessionId + ':' + index
}

export interface CMProblem {
  sessionId: string
  kind: 'dangling-share' | 'self-mis' | 'shared-overflow'
  index: number
}

/** 不变量校验：共享段必须解析到祖先自身轮；自有段必须归属本会话。 */
export function validateFamily(family: CMFamily): CMProblem[] {
  const problems: CMProblem[] = []
  for (const session of family.sessions) {
    if (session.shared > session.turns.length) {
      problems.push({ sessionId: session.id, kind: 'shared-overflow', index: session.shared })
    }
    for (let i = 0; i < session.shared; i += 1) {
      if (originOf(family, session.id, i) === null) {
        problems.push({ sessionId: session.id, kind: 'dangling-share', index: i })
      }
    }
    for (let i = session.shared; i < session.turns.length; i += 1) {
      if (originOf(family, session.id, i) !== session.id + ':' + i) {
        problems.push({ sessionId: session.id, kind: 'self-mis', index: i })
      }
    }
  }
  return problems
}

/** 会话在合并树里的自身叶子路径（origin id 序列）：图渲染与删除锚点都用它。 */
export function pathOf(family: CMFamily, sessionId: string): CMOriginId[] {
  const session = family.byId.get(sessionId)
  if (!session) return []
  const path: CMOriginId[] = []
  for (let i = 0; i < session.turns.length; i += 1) {
    const origin = originOf(family, sessionId, i)
    if (origin) path.push(origin)
  }
  return path
}

/** ---------------------------------------------------------------------------
 * 页码指示器：把分叉图（合并树）的成组逻辑投影为可切换的 <k/n>。
 *
 * 与 BranchGraph 同一规则（本函数是它建图的纯函数提炼，避免第二套分组）：
 *   - 每个会话按日志轮建 chain；i < shared 的轮是祖先拷贝，unit 直接引用祖先；
 *   - kind=regenerate 的分支，其首轮提问不新建提问节点，回复并到祖先提问节点下；
 *   - 其余自有轮各建提问节点，回复挂在提问下。
 * 由此得到两类"兄弟组"：
 *   answersOf[提问节点]   = 同一提问的全部回复（答案页：A2.1<1/2>、A2.2<2/2>）
 *   questionsOf[回复节点]  = 紧随同一回复的多个提问（提问页：Q3.1<1/2>、Q3.2<2/2>）
 * 组按 family.sessions（BFS、创建序）累积，成员顺序即页码顺序。
 * ------------------------------------------------------------------------- */
export interface CMPageUnit {
  /** 规范提问节点 id（形如 <session>:u:<turn>；regenerate 合并后为祖先的 id）。 */
  userId: string
  /** 本会话为该提问新产生的回复节点 id（形如 <session>:a:<turn>:<reply>）。 */
  replyIds: string[]
}

export interface CMPageFamily {
  /** 会话 -> 整链 unit（共享轮引用祖先 unit）。 */
  chains: Map<string, CMPageUnit[]>
  /** 提问节点 id -> 其下全部回复节点 id（答案页成员，创建序）。 */
  answersOf: Map<string, string[]>
  /** 回复节点 id -> 紧随其后的提问节点 id（提问页成员，创建序）。 */
  questionsOf: Map<string, string[]>
  /** 回复节点 id -> 产出的 (会话, 轮, 回复下标)，供卡片匹配页码位置。 */
  replyOwnerOf: Map<string, { sessionId: string; turnIndex: number; replyIndex: number }>
  /** 提问节点 id -> 其所在会话（regenerate 合并节点归祖先会话）。切页定位用。 */
  userOwnerOf: Map<string, string>
  /** 提问节点 id -> 其父回复节点 id（有则属于某提问页）。 */
  userPageParentOf: Map<string, string>
}

export function buildPageFamily(family: CMFamily, branchKinds: Record<string, string | undefined>): CMPageFamily {
  const chains = new Map<string, CMPageUnit[]>()
  const answersOf = new Map<string, string[]>()
  const questionsOf = new Map<string, string[]>()
  const replyOwnerOf = new Map<string, { sessionId: string; turnIndex: number; replyIndex: number }>()
  const userOwnerOf = new Map<string, string>()
  const userPageParentOf = new Map<string, string>()

  const pushUnique = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key)
    if (list === undefined) {
      map.set(key, [value])
    } else if (list[list.length - 1] !== value && !list.includes(value)) {
      list.push(value)
    }
  }

  for (const session of family.sessions) {
    const parentChain =
      session.parentTopicId !== undefined && session.parentTopicId.length > 0
        ? chains.get(session.parentTopicId)
        : undefined
    // 防御：共享段截到父链可引用的前缀（正常血缘下 shared <= 父轮数恒成立）
    const shared = parentChain ? Math.min(session.shared, parentChain.length) : 0
    const chain: CMPageUnit[] = []
    const isRegenerate = branchKinds[session.id] === 'regenerate'
    // parallel（切换模型回答的隐藏旁答子会话）：不进页码体系——
    // 其自有轮不注册 answersOf/questionsOf/owner，切页/页签箭头对旁答不可见。
    // 链（chains）照常建：共享前缀引用祖先单元，旁答轮挂自己的 unit，
    // 这样将来若有后代也不至于找父链失败。
    const isParallel = branchKinds[session.id] === 'parallel'

    for (let index = 0; index < session.turns.length; index += 1) {
      if (index < shared && parentChain?.[index] !== undefined) {
        // 复制轮：引用祖先 unit，不重复建节点
        chain.push(parentChain[index] as CMPageUnit)
        continue
      }
      let ownerUser: string
      if (index === shared && isRegenerate && parentChain !== undefined && parentChain[index] !== undefined) {
        // regenerate：提问并入祖先提问节点，回复挂在祖先提问下
        ownerUser = (parentChain[index] as CMPageUnit).userId
      } else {
        ownerUser = session.id + ':u:' + index
        if (!isParallel) userOwnerOf.set(ownerUser, session.id)
      }
      const replyIds: string[] = []
      const turnReplies = session.turns[index]?.replies ?? []
      turnReplies.forEach((_reply, replyIndex) => {
        const replyId = session.id + ':a:' + index + ':' + replyIndex
        if (!isParallel) {
          pushUnique(answersOf, ownerUser, replyId)
          replyOwnerOf.set(replyId, { sessionId: session.id, turnIndex: index, replyIndex })
        }
        replyIds.push(replyId)
      })
      const unit: CMPageUnit = { userId: ownerUser, replyIds }
      chain.push(unit)
      // 链边：前一 unit 的最后回复（无回复则用前一提问）→ 本提问；仅源是回复节点时构成"提问页"
      // （parallel 会话的自有轮不产生链边 = 不占任何提问页）
      if (index > 0 && !isParallel) {
        const prev = chain[index - 1] as CMPageUnit
        if (prev.userId !== unit.userId) {
          const source = prev.replyIds.length > 0 ? (prev.replyIds[prev.replyIds.length - 1] as string) : prev.userId
          if (source.indexOf(':a:') !== -1) {
            pushUnique(questionsOf, source, unit.userId)
            userPageParentOf.set(unit.userId, source)
          }
        }
      }
    }
    chains.set(session.id, chain)
  }

  return { chains, answersOf, questionsOf, replyOwnerOf, userOwnerOf, userPageParentOf }
}

export interface CMPagePosition {
  kind: 'reply' | 'question'
  /** 本卡片所在组的全部成员节点 id（含自己），顺序即页码。 */
  members: string[]
  currentIndex: number
}
