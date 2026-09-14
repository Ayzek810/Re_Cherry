import { isInjectedUserEvent, uiSessionEvent, uiSessionEvents } from '../sessionEventView'

/** 注入快照（RuntimeContextProjection 产出的插件源 user 消息）。 */
const injected = {
  seq: 7,
  type: 'user/message',
  data: {
    content: [{ type: 'text', text: 'Current runtime context\nTools: read, write.' }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }
  }
}

/** 真实用户发言。 */
const fromUser = {
  seq: 9,
  type: 'user/message',
  data: { content: [{ type: 'text', text: '帮我看看这个文件' }], source: { kind: 'user' } }
}

const assistant = {
  seq: 10,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '好的' }], source: { provider: 'p', model: 'm' } } }
}

describe('isInjectedUserEvent', () => {
  it('识别插件源 user 消息为注入', () => {
    expect(isInjectedUserEvent(injected)).toBe(true)
  })

  it('真实用户发言、助手消息、非消息事件都不是注入', () => {
    expect(isInjectedUserEvent(fromUser)).toBe(false)
    expect(isInjectedUserEvent(assistant)).toBe(false)
    expect(isInjectedUserEvent({ seq: 1, type: 'turn/start', data: {} })).toBe(false)
  })

  it('source 缺失（旧库/坏行）按非注入处理——宁可显示，不静默吞掉用户内容', () => {
    expect(isInjectedUserEvent({ seq: 2, type: 'user/message', data: { content: [] } })).toBe(false)
    expect(isInjectedUserEvent({ seq: 3, type: 'user/message', data: { source: {} } })).toBe(false)
  })
})

describe('uiSessionEvents / uiSessionEvent', () => {
  it('过滤掉注入消息，保留其余事件顺序', () => {
    const events = [injected, fromUser, assistant]
    const view = uiSessionEvents(events)
    expect(view.map((event) => event.seq)).toEqual([9, 10])
    expect(events).toHaveLength(3) // 原数组不被改动
  })

  it('直播单条过滤：注入返回 undefined，其余原样返回', () => {
    expect(uiSessionEvent(injected)).toBeUndefined()
    expect(uiSessionEvent(fromUser)).toBe(fromUser)
    expect(uiSessionEvent(assistant)).toBe(assistant)
  })
})
