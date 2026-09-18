import { describe, expect, it } from 'vitest'

import { buildPageFamily, type CMFamily, type CMSession, originOf } from '../conversationModel'

/** 手工构造会话（纯函数测试；replies 数组与页码分组成员一一对应）。 */
function session(
  id: string,
  parentTopicId: string | undefined,
  shared: number,
  turns: Array<{ text: string; replies: number }>
): CMSession {
  return {
    id,
    name: id,
    parentTopicId,
    shared,
    turns: turns.map((turn) => ({
      text: turn.text,
      replies: Array.from({ length: turn.replies }, (_, r) => ({ text: '答' + turn.text + '-' + r }))
    }))
  }
}

/** 造家族：按 parent-first 顺序铺开并建 byId（与 loadFamily 的 BFS 顺序约定一致）。 */
function family(...sessions: CMSession[]): CMFamily {
  return { rootId: sessions[0]?.id ?? 'root', sessions, byId: new Map(sessions.map((s) => [s.id, s])) }
}

describe('buildPageFamily（页码 = 分叉图合并树投影）', () => {
  it('答案页：regenerate 的回复并入祖先提问，原答 + 各再生份按创建序成页', () => {
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]), // R:a:0:0 原答
      session('C1', 'R', 0, [{ text: 'Q1', replies: 1 }]), // regenerate C1:a:0:0
      session('C2', 'R', 0, [{ text: 'Q1', replies: 1 }]) // regenerate C2:a:0:0
    )
    const page = buildPageFamily(F, { C1: 'regenerate', C2: 'regenerate' })
    // 三个答案同挂提问节点 R:u:0 下
    expect(page.answersOf.get('R:u:0')).toEqual(['R:a:0:0', 'C1:a:0:0', 'C2:a:0:0'])
    // regenerate 子会话不新建提问节点（无 C1:u:0）
    expect(page.userOwnerOf.has('C1:u:0')).toBe(false)
    expect(page.userOwnerOf.get('R:u:0')).toBe('R')
    // 无任何提问页
    expect(page.questionsOf.size).toBe(0)
  })

  it('提问页：同一父回复下的多个后续提问（原问 + 重发拷贝）成页', () => {
    const F = family(
      session('P', undefined, 0, [
        { text: 'Q1', replies: 1 }, // P:a:0:0
        { text: 'Q3.1', replies: 1 } // P 自己后续的提问 Q3.1
      ]),
      session('C', 'P', 1, [
        { text: 'Q1(共享)', replies: 1 }, // 共享轮占位（parse 会原样拷贝回复，这里用占位计数）
        { text: 'Q3.2', replies: 1 } // 编辑重发出来的 Q3.2
      ])
    )
    const page = buildPageFamily(F, { C: 'resend' })
    // Q3.1/Q3.2 都接在 P 的回复 P:a:0:0 之后
    expect(page.questionsOf.get('P:a:0:0')).toEqual(['P:u:1', 'C:u:1'])
    expect(page.userPageParentOf.get('P:u:1')).toBe('P:a:0:0')
    expect(page.userPageParentOf.get('C:u:1')).toBe('P:a:0:0')
    // 共享轮不重复造答案节点
    expect(page.answersOf.get('P:u:0')).toEqual(['P:a:0:0'])
    expect(page.replyOwnerOf.has('C:a:0:0')).toBe(false) // C 的共享轮没有自己的回复节点
  })

  it('共享前缀/祖先拷贝不重复成组', () => {
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]),
      session('M', 'R', 1, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q2', replies: 1 }
      ]),
      session('C', 'M', 2, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q2(共享)', replies: 1 },
        { text: 'Q3', replies: 1 }
      ])
    )
    const page = buildPageFamily(F, {})
    expect(page.answersOf.get('R:u:0')).toEqual(['R:a:0:0'])
    expect(page.answersOf.get('M:u:1')).toEqual(['M:a:1:0'])
    expect(page.answersOf.get('C:u:2')).toEqual(['C:a:2:0'])
    // 共享前缀不重复产生回复节点
    expect(page.replyOwnerOf.size).toBe(3)
  })

  it('parallel：旁答不进页码体系——不并答页、不占提问页、不注册 owner/边', () => {
    const F = family(
      session('P', undefined, 0, [
        { text: 'Q1', replies: 1 }, // P:a:0:0
        { text: 'Q2', replies: 1 } // P:a:1:0（锚点轮原答）
      ]),
      session('C1', 'P', 1, [
        { text: 'Q1(共享)', replies: 1 }, // 共享轮（chain 引用 P:u:0）
        { text: 'Q2(并行拷贝)', replies: 1 } // C1 自有轮 = 对 Q2 的并行回答
      ])
    )
    const page = buildPageFamily(F, { C1: 'parallel' })
    // 提问页：P 的 Q2 原问独占（并行拷贝提问不加入页）
    expect(page.questionsOf.get('P:a:0:0')).toEqual(['P:u:1'])
    // 答案页：原答独占（并行回答不并入——区别于 regenerate）
    expect(page.answersOf.get('P:u:1')).toEqual(['P:a:1:0'])
    // 其余轮不受影响
    expect(page.answersOf.get('P:u:0')).toEqual(['P:a:0:0'])
    // parallel 自有轮不注册任何映射
    expect(page.userOwnerOf.has('C1:u:1')).toBe(false)
    expect(page.replyOwnerOf.has('C1:a:1:0')).toBe(false)
    expect(page.userPageParentOf.has('C1:u:1')).toBe(false)
    // 链仍可用（共享轮引用祖先单元；旁答轮挂自己的 unit）
    const chain = page.chains.get('C1')
    expect(chain?.[0]?.userId).toBe('P:u:0')
    expect(chain?.[1]?.userId).toBe('C1:u:1')
  })

  it('parallel：regenerate 页不受 parallel 存在的影响；同锚多 parallel 互不并页', () => {
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]),
      session('G', 'R', 0, [{ text: 'Q1', replies: 1 }]), // regenerate：并答页
      session('C1', 'R', 0, [{ text: 'Q1', replies: 1 }]), // parallel 1
      session('C2', 'R', 0, [{ text: 'Q1', replies: 1 }]) // parallel 2（同锚另一模型）
    )
    const page = buildPageFamily(F, { G: 'regenerate', C1: 'parallel', C2: 'parallel' })
    // 答案页 = 原答 + regenerate 份；两个 parallel 的旁答均不进
    expect(page.answersOf.get('R:u:0')).toEqual(['R:a:0:0', 'G:a:0:0'])
    expect(page.replyOwnerOf.has('C1:a:0:0')).toBe(false)
    expect(page.replyOwnerOf.has('C2:a:0:0')).toBe(false)
    expect(page.userOwnerOf.has('C1:u:0')).toBe(false)
    expect(page.userOwnerOf.has('C2:u:0')).toBe(false)
  })

  it('回复页成员的 owner 映射指向产出的会话（切页定位用）', () => {
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]),
      session('C1', 'R', 0, [{ text: 'Q1', replies: 1 }])
    )
    const page = buildPageFamily(F, { C1: 'regenerate' })
    expect(page.replyOwnerOf.get('R:a:0:0')).toEqual({ sessionId: 'R', turnIndex: 0, replyIndex: 0 })
    expect(page.replyOwnerOf.get('C1:a:0:0')).toEqual({ sessionId: 'C1', turnIndex: 0, replyIndex: 0 })
    // 提问页切换目标：原问在 P、重发拷贝在 C
    expect(page.userOwnerOf.get('R:u:0')).toBe('R')
    expect(page.userOwnerOf.has('C1:u:0')).toBe(false)
  })

  it('共享边界权威：祖先删轮后子日志的 shared 停在历史形状 → 钳到父链现长并暴露给门控（9141be6f 族真机实证）', () => {
    // 真实缺陷形态：R 原 3 轮时 S fork（seed 至第 2 轮末，shared=2），之后 R 删掉第 2 轮只剩 1 轮。
    // S 的日志保留全部 3 个 seed 轮，其 shared=2 大于父链现长 1。
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]), // R 现在只剩 1 轮
      session('S', 'R', 2, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q2(祖先已删轮的拷贝)', replies: 1 },
        { text: 'Q3', replies: 1 }
      ])
    )
    const page = buildPageFamily(F, { S: 'regenerate' })
    // 钳制：门控权威 = 父链现长 1，而非子日志声称的 2（根恒 0）
    expect(page.sharedBoundaryOf.get('S')).toBe(1)
    expect(page.sharedBoundaryOf.get('R')).toBe(0)
    // 后果一（修复前）：页码条直接吃 session.shared=2 → S 的第 1、2 轮全被当"共享区"，
    // 整组页码被吞；现在边界=1 → 第 1/2 轮都是自有区。
    // 后果二：第 1 轮在祖先链里没有对应单元（R 链长 1），合并不成立，S 只能自立提问节点
    expect(page.userOwnerOf.get('S:u:1')).toBe('S')
    expect(page.answersOf.get('S:u:1')).toEqual(['S:a:1:0'])
    expect(page.answersOf.get('S:u:2')).toEqual(['S:a:2:0'])
    // 链完整（3 轮），第 0 轮引用祖先单元
    expect(page.chains.get('S')?.length).toBe(3)
    expect(page.chains.get('S')?.[0]?.userId).toBe('R:u:0')
    expect(page.chains.get('S')?.[1]?.userId).toBe('S:u:1')
  })

  it('共享边界权威：无删轮的正常血缘下钳制值 = 原值（不改变既有分组）', () => {
    const F = family(
      session('P', undefined, 0, [
        { text: 'Q1', replies: 1 },
        { text: 'Q2', replies: 1 }
      ]),
      session('C', 'P', 1, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q3', replies: 1 }
      ])
    )
    const page = buildPageFamily(F, { C: 'resend' })
    expect(page.sharedBoundaryOf.get('C')).toBe(1)
    expect(page.sharedBoundaryOf.get('P')).toBe(0)
    // 既有分组不受影响
    expect(page.questionsOf.get('P:a:0:0')).toEqual(['P:u:1', 'C:u:1'])
  })

  it('originOf 同一权威：祖先删轮后 shared 停在历史形状 → 钳到父链现长，不再打进父已删的轮（unresolved warn 根除）', () => {
    // 与 sharedBoundaryOf 用例同形态：R 只剩 1 轮，S 日志 shared=2
    const F = family(
      session('R', undefined, 0, [{ text: 'Q1', replies: 1 }]),
      session('S', 'R', 2, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q2(祖先已删轮的拷贝)', replies: 1 },
        { text: 'Q3', replies: 1 }
      ])
    )
    // 旧逻辑：index1 < rawShared2 → 递归进 R:1（不存在）→ null（warn 降级）
    // 新逻辑：钳制边界1 → index1 自有
    expect(originOf(F, 'S', 1)).toBe('S:1')
    expect(originOf(F, 'S', 2)).toBe('S:2')
    // 共享段照常归祖先
    expect(originOf(F, 'S', 0)).toBe('R:0')
    // 正常血缘不受影响（边界 = 原值）
    const N = family(
      session('P', undefined, 0, [{ text: 'Q1', replies: 1 }]),
      session('C', 'P', 1, [
        { text: 'Q1(共享)', replies: 1 },
        { text: 'Q2', replies: 1 }
      ])
    )
    expect(originOf(N, 'C', 0)).toBe('P:0')
    expect(originOf(N, 'C', 1)).toBe('C:1')
  })
})
