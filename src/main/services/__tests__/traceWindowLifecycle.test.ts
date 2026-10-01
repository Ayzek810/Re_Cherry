/**
 * trace 窗口语言回调的订阅生命周期与空引用守卫。
 *
 * 原实现两个缺陷：
 * ① `did-finish-load` 每次都 `configManager.subscribe`（数组 push），而 `closed` 只退订一次；
 *    reload / HMR / 重定向后再触发 `did-finish-load` 即造成重复订阅 —— 一次语言切换向同一
 *    窗口发 N 次 `set-language`。
 * ② 回调体是 `traceWin!.webContents.send(...)`（模块级可变引用 + 非空断言）。窗口已 closed、
 *    `traceWin` 已置 null 的窗口期里，回调抛 `TypeError: Cannot read properties of null`；
 *    该异常发生在 `ConfigManager.notifySubscribers` 的同步 `forEach` 内，会中断同批后续
 *    订阅者，把「切语言」变成部分失效。
 *
 * 本文件锁定两条事实：订阅成对（重复 load 不叠加）、关闭后回调不再触碰窗口且不抛。
 */
import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigKeys, configManager } from '../ConfigManager'

type Handler = (...args: unknown[]) => void

const wins: Array<{
  send: ReturnType<typeof vi.fn>
  destroyed: boolean
  handlers: Map<string, Handler[]>
  wcHandlers: Map<string, Handler[]>
  isDestroyed: () => boolean
  focus: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
  emitWc: (event: string, ...args: unknown[]) => void
}> = []

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(() => {
    const handlers = new Map<string, Handler[]>()
    const wcHandlers = new Map<string, Handler[]>()
    const win = {
      handlers,
      wcHandlers,
      destroyed: false,
      send: vi.fn(),
      focus: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
      loadFile: vi.fn(() => Promise.resolve()),
      title: '',
      isDestroyed: () => win.destroyed,
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      webContents: {
        on: (event: string, handler: Handler) => {
          wcHandlers.set(event, [...(wcHandlers.get(event) ?? []), handler])
        },
        send: vi.fn()
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of handlers.get(event) ?? []) handler(...args)
      },
      emitWc: (event: string, ...args: unknown[]) => {
        for (const handler of wcHandlers.get(event) ?? []) handler(...args)
      }
    }
    win.webContents.send = win.send
    wins.push(win)
    return win
  })
  return { __esModule: true, BrowserWindow, default: { BrowserWindow } }
})

const { openTraceWindow } = await import('../NodeTraceService')

/** 订阅表里当前挂着的语言订阅者数量（ConfigManager 的 subscribe 是数组 push）。 */
function languageSubscriberCount(): number {
  return (
    (configManager as unknown as { subscribers: Map<string, Handler[]> }).subscribers.get(ConfigKeys.Language)
      ?.length ?? 0
  )
}

/** 本次窗口收到的语言推送（通道名取自真实常量，不用字面量，避免与 IpcChannel 脱钩）。 */
function languageSends(win: (typeof wins)[number]): unknown[][] {
  return win.send.mock.calls.filter(([channel]) => channel === IpcChannel.Trace_SetLanguage) as unknown[][]
}

describe('trace 窗口语言订阅生命周期', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wins.length = 0
    // 清空订阅表：模块级单例跨用例残留会污染计数。
    ;(configManager as unknown as { subscribers: Map<string, unknown> }).subscribers.clear()
  })

  // 无论用例是否断言失败，都走一次 closed，复位 NodeTraceService 的模块级 `traceWin`。
  // 否则一条用例中途失败会让下一条的 `openTraceWindow` 提前返回，报出与根因无关的次生错误。
  afterEach(() => {
    for (const win of wins) win.emit('closed')
  })

  it('重复 did-finish-load 不叠加订阅者，一次语言切换只发一次 set-language', () => {
    openTraceWindow('topic-1', 'trace-1')
    const win = wins[0]

    win.emitWc('did-finish-load')
    expect(languageSubscriberCount()).toBe(1)
    win.emitWc('did-finish-load')
    win.emitWc('did-finish-load')
    expect(languageSubscriberCount()).toBe(1)

    win.send.mockClear()
    configManager.setAndNotify(ConfigKeys.Language, 'en-US')

    const sends = languageSends(win)
    expect(sends).toHaveLength(1)
    expect(sends[0][1]).toEqual({ lang: 'en-US' })

    // 收尾由 afterEach 的 `closed` 负责（模块级引用复位，下一条用例要新建窗口）
  })

  it('窗口关闭后再切语言：不抛异常且不再向该窗口发送', () => {
    openTraceWindow('topic-2', 'trace-2')
    const win = wins[0]
    win.emitWc('did-finish-load')
    expect(languageSubscriberCount()).toBe(1)

    // 关闭：先触发 closed（退订 + 清模块级引用），再标记已销毁。
    win.emit('closed')
    win.destroyed = true
    expect(languageSubscriberCount()).toBe(0)

    win.send.mockClear()
    // 旧实现此处抛 TypeError: Cannot read properties of null（模块级 traceWin 已 null）。
    expect(() => configManager.setAndNotify(ConfigKeys.Language, 'zh-CN')).not.toThrow()
    expect(win.send).not.toHaveBeenCalled()
  })

  it('同一批订阅者不因 trace 窗口异常而中断（后续订阅者仍被通知）', () => {
    openTraceWindow('topic-3', 'trace-3')
    const win = wins[0]
    win.emitWc('did-finish-load')
    win.destroyed = true // 模拟「已 closed 但同一批订阅者仍在遍历」的窗口期

    const laterSubscriber = vi.fn()
    configManager.subscribe(ConfigKeys.Language, laterSubscriber)

    expect(() => configManager.setAndNotify(ConfigKeys.Language, 'en-US')).not.toThrow()
    expect(laterSubscriber).toHaveBeenCalledWith('en-US')
  })
})
