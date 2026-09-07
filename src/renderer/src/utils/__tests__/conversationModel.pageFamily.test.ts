import { describe, expect, it } from 'vitest'

import {
  buildPageFamily,
  type CMFamily,
  type CMSession
} from '../conversationModel'

/** 手工构造会话（纯函数测试；replies 数组与页码分组成员一一对应）。 */
function session(id: string, parentTopicId: string | undefined, shared: number, turns: Array<{ text: string; replies: number }>): CMSession {
  return {
    id,
    name: id,
    parentTopicId,
    shared,
    turns: turns.map((turn) => ({ text: turn.text, replies: Array.from({ length: turn.replies }, (_, r) => ({ text: '答' + turn.text + '-' + r })) }))
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
      session('M', 'R', 1, [{ text: 'Q1(共享)', replies: 1 }, { text: 'Q2', replies: 1 }]),
      session('C', 'M', 2, [{ text: 'Q1(共享)', replies: 1 }, { text: 'Q2(共享)', replies: 1 }, { text: 'Q3', replies: 1 }])
    )
    const page = buildPageFamily(F, {})
    expect(page.answersOf.get('R:u:0')).toEqual(['R:a:0:0'])
    expect(page.answersOf.get('M:u:1')).toEqual(['M:a:1:0'])
    expect(page.answersOf.get('C:u:2')).toEqual(['C:a:2:0'])
    // 共享前缀不重复产生回复节点
    expect(page.replyOwnerOf.size).toBe(3)
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
})