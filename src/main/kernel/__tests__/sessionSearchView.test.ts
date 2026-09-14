import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { searchSessions } from '../topics'

/**
 * v0.3.0 的注入封堵漏掉了历史搜索：`searchSessions` 遍历全部 user/message 事件，
 * 注入快照会以 role:'user' 的形式出现在结果里（用户会看到自己"没说过"的话）。
 * 本测试锁定 v0.3.0-1 的修复：UI 视界判据同样施用在这一出口。
 */
const events = [
  {
    seq: 1,
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: 'Current runtime context\nTools: read, write.\n配置: 工作区' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }
    }
  },
  {
    seq: 2,
    type: 'user/message',
    data: { content: [{ type: 'text', text: '工具面怎么配置？' }], source: { kind: 'user' } }
  },
  {
    seq: 3,
    type: 'assistant/message',
    data: {
      message: {
        content: [{ type: 'text', text: '在权限模式页里配置工作区。' }],
        source: { provider: 'p', model: 'm' }
      }
    }
  }
] as unknown as SessionEvent[]

function fakeContext(sessionEvents: SessionEvent[]): Context {
  return {
    sessionPersistence: {
      list: async () => [{ id: 's1', createdAt: 1, updatedAt: 2 }],
      inspect: async () => ({ events: sessionEvents })
    }
  } as unknown as Context
}

describe('searchSessions（UI 视界）', () => {
  it('注入快照不参与检索：命中只来自真实用户轮与助手回答', async () => {
    const hits = await searchSessions(fakeContext(events), ['配置'])
    expect(hits.map((hit) => hit.seq)).toEqual([2, 3])
    expect(hits.every((hit) => !hit.text.includes('Current runtime context'))).toBe(true)
  })

  it('只有注入快照命中的关键词返回空结果，而不是伪装成用户发言', async () => {
    const hits = await searchSessions(fakeContext(events), ['Current runtime context'])
    expect(hits).toEqual([])
  })

  it('正常检索行为不变（AND、大小写不敏感）', async () => {
    const hits = await searchSessions(fakeContext(events), ['WORKSPACE'.toLowerCase(), 'read'])
    expect(hits).toEqual([]) // 'workspace' 不在任何真实用户/助手文本里
  })
})
