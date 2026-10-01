/**
 *
 * 缺陷：boot 注册用一个模块级布尔 `isRegisterOnBoot` 记账，只在**第一次**
 * `createMainWindow` 时挂 `ready-to-show`。主窗可在运行期重建（托盘场景下窗口被系统回收、
 * `WindowService.showMainWindow()` 新建、macOS activate 分支新建），而新建窗口的
 * `isFocused()` 在重建瞬间通常为 false ⇒ show_app/mini_window 全局键要等用户手动点一次
 * 窗口才回来。`ready-to-show` 是唯一不依赖焦点的 boot 注册点。
 *
 * 修法：按窗口记账（WeakSet），每个窗口各自挂一次 `ready-to-show`。
 */
import type { BrowserWindow } from 'electron'
import { globalShortcut } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ShortcutService 经 WindowService 拉进 `@electron-toolkit/utils` 的 CJS 链，该链在
// vitest 下会绕过 setup 的 electron 桩（真实包无 BrowserWindow 具名导出）。本文件只关心
// 快捷键注册的记账行为，故把窗口服务缝桩掉。
vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => null),
    toggleMainWindow: vi.fn(),
    toggleMiniWindow: vi.fn()
  }
}))

import { configManager } from '../ConfigManager'
import { registerShortcuts } from '../ShortcutService'

type Listener = (...args: unknown[]) => void

/** 只实现 registerShortcuts 消费到的窗口表面。 */
class FakeWindow {
  readonly readyToShowListeners: Listener[] = []
  readonly focusListeners: Listener[] = []
  readonly blurListeners: Listener[] = []
  focused = false
  destroyed = false

  once(event: string, listener: Listener): this {
    if (event === 'ready-to-show') this.readyToShowListeners.push(listener)
    return this
  }

  on(event: string, listener: Listener): this {
    if (event === 'focus') this.focusListeners.push(listener)
    if (event === 'blur') this.blurListeners.push(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    if (event === 'focus') this.focusListeners.splice(this.focusListeners.indexOf(listener) >>> 0, 1)
    if (event === 'blur') this.blurListeners.splice(this.blurListeners.indexOf(listener) >>> 0, 1)
    return this
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isFocused(): boolean {
    return this.focused
  }

  emitReadyToShow(): void {
    for (const listener of [...this.readyToShowListeners]) listener()
  }
}

function asWindow(fake: FakeWindow): BrowserWindow {
  return fake as unknown as BrowserWindow
}

const SHOW_APP_ACCELERATOR = 'CommandOrControl+Shift+A'
const MINI_WINDOW_ACCELERATOR = 'CommandOrControl+Shift+M'

describe('registerShortcuts boot registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(configManager, 'getShortcuts').mockReturnValue([
      { key: 'show_app', shortcut: ['CommandOrControl', 'Shift', 'A'], enabled: true },
      { key: 'mini_window', shortcut: ['CommandOrControl', 'Shift', 'M'], enabled: true }
    ] as never)
    vi.spyOn(configManager, 'getLaunchToTray').mockReturnValue(true)
  })

  it('registers universal shortcuts on the first window ready-to-show', () => {
    const fake = new FakeWindow()
    registerShortcuts(asWindow(fake))
    expect(fake.readyToShowListeners).toHaveLength(1)

    fake.emitReadyToShow()
    expect(vi.mocked(globalShortcut.register)).toHaveBeenCalledWith(SHOW_APP_ACCELERATOR, expect.any(Function))
    expect(vi.mocked(globalShortcut.register)).toHaveBeenCalledWith(MINI_WINDOW_ACCELERATOR, expect.any(Function))
  })

  it('arms a freshly rebuilt window again (the module-level flag used to consume this)', () => {
    const first = new FakeWindow()
    registerShortcuts(asWindow(first))
    first.emitReadyToShow() // 第一次 boot 注册被消耗

    // 主窗重建：新窗口、无焦点（托盘/系统回收后新建的常态）。
    const rebuilt = new FakeWindow()
    registerShortcuts(asWindow(rebuilt))
    expect(rebuilt.readyToShowListeners).toHaveLength(1)

    vi.mocked(globalShortcut.register).mockClear()
    rebuilt.emitReadyToShow()
    expect(vi.mocked(globalShortcut.register)).toHaveBeenCalledWith(SHOW_APP_ACCELERATOR, expect.any(Function))
    expect(vi.mocked(globalShortcut.register)).toHaveBeenCalledWith(MINI_WINDOW_ACCELERATOR, expect.any(Function))
  })

  it('does not stack duplicate ready-to-show listeners on the same window', () => {
    const fake = new FakeWindow()
    registerShortcuts(asWindow(fake))
    registerShortcuts(asWindow(fake))
    registerShortcuts(asWindow(fake))
    expect(fake.readyToShowListeners).toHaveLength(1)
  })

  it('still attaches the focus/blur handlers only once per window', () => {
    const fake = new FakeWindow()
    registerShortcuts(asWindow(fake))
    registerShortcuts(asWindow(fake))
    expect(fake.focusListeners).toHaveLength(1)
    expect(fake.blurListeners).toHaveLength(1)
  })
})
