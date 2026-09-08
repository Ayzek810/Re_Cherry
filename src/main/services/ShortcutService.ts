/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import { handleZoomFactor } from '@main/utils/zoom'
import type { Shortcut } from '@types'
import type { BrowserWindow } from 'electron'
import { globalShortcut } from 'electron'

import { configManager } from './ConfigManager'
import { windowService } from './WindowService'

const logger = loggerService.withContext('ShortcutService')

let showAppAccelerator: string | null = null
let showMiniWindowAccelerator: string | null = null

//indicate if the shortcuts are registered on app boot time
let isRegisterOnBoot = true

// store the focus and blur handlers for each window to unregister them later
const windowOnHandlers = new Map<BrowserWindow, { onFocusHandler: () => void; onBlurHandler: () => void }>()

function getShortcutHandler(shortcut: Shortcut) {
  switch (shortcut.key) {
    case 'zoom_in':
      return (window: BrowserWindow) => handleZoomFactor([window], 0.1)
    case 'zoom_out':
      return (window: BrowserWindow) => handleZoomFactor([window], -0.1)
    case 'zoom_reset':
      return (window: BrowserWindow) => handleZoomFactor([window], 0, true)
    case 'show_app':
      return () => {
        windowService.toggleMainWindow()
      }
    case 'mini_window':
      return () => {
        // 在处理器内部检查QuickAssistant状态，而不是在注册时检查
        const quickAssistantEnabled = configManager.getEnableQuickAssistant()
        logger.info(`mini_window shortcut triggered, QuickAssistant enabled: ${quickAssistantEnabled}`)

        if (!quickAssistantEnabled) {
          logger.warn('QuickAssistant is disabled, ignoring mini_window shortcut trigger')
          return
        }

        windowService.toggleMiniWindow()
      }
    default:
      return null
  }
}

function formatShortcutKey(shortcut: string[]): string {
  return shortcut.join('+')
}

// convert the shortcut recorded by JS keyboard event key value to electron global shortcut format
// see: https://www.electronjs.org/zh/docs/latest/api/accelerator
const convertShortcutFormat = (shortcut: string | string[]): string => {
  const accelerator = (() => {
    if (Array.isArray(shortcut)) {
      return shortcut
    } else {
      return shortcut.split('+').map((key) => key.trim())
    }
  })()

  return accelerator
    .map((key) => {
      switch (key) {
        // OLD WAY FOR MODIFIER KEYS, KEEP THEM HERE FOR REFERENCE
        // case 'Command':
        //   return 'CommandOrControl'
        // case 'Control':
        //   return 'Control'
        // case 'Ctrl':
        //   return 'Control'

        // NEW WAY FOR MODIFIER KEYS
        // you can see all the modifier keys in the same
        case 'CommandOrControl':
          return 'CommandOrControl'
        case 'Ctrl':
          return 'Ctrl'
        case 'Alt':
          return 'Alt' // Use `Alt` instead of `Option`. The `Option` key only exists on macOS, whereas the `Alt` key is available on all platforms.
        case 'Meta':
          return 'Meta' // `Meta` key is mapped to the Windows key on Windows and Linux, `Cmd` on macOS.
        case 'Shift':
          return 'Shift'

        // For backward compatibility with old data
        case 'Command':
        case 'Cmd':
          return 'CommandOrControl'
        case 'Control':
          return 'Ctrl'

        case 'ArrowUp':
          return 'Up'
        case 'ArrowDown':
          return 'Down'
        case 'ArrowLeft':
          return 'Left'
        case 'ArrowRight':
          return 'Right'
        case 'AltGraph':
          return 'AltGr'
        case 'Slash':
          return '/'
        case 'Semicolon':
          return ';'
        case 'BracketLeft':
          return '['
        case 'BracketRight':
          return ']'
        case 'Backslash':
          return '\\'
        case 'Quote':
          return "'"
        case 'Comma':
          return ','
        case 'Minus':
          return '-'
        case 'Equal':
          return '='
        default:
          return key
      }
    })
    .join('+')
}

function registerInternal(window: BrowserWindow | null, onlyUniversalShortcuts: boolean = false) {
  const shortcuts = configManager.getShortcuts()
  if (!shortcuts) return

  shortcuts.forEach((shortcut) => {
    try {
      if (shortcut.shortcut.length === 0) {
        return
      }

      //if not enabled, exit early from the process.
      if (!shortcut.enabled) {
        return
      }

      // only register universal shortcuts when needed
      if (onlyUniversalShortcuts && !['show_app', 'mini_window'].includes(shortcut.key)) {
        return
      }

      const handler = getShortcutHandler(shortcut)
      if (!handler) {
        return
      }

      switch (shortcut.key) {
        case 'show_app':
          showAppAccelerator = formatShortcutKey(shortcut.shortcut)
          break

        case 'mini_window':
          // 移除注册时的条件检查，在处理器内部进行检查
          logger.info(`Processing mini_window shortcut, enabled: ${shortcut.enabled}`)
          showMiniWindowAccelerator = formatShortcutKey(shortcut.shortcut)
          logger.debug(`Mini window accelerator set to: ${showMiniWindowAccelerator}`)
          break

        //the following ZOOMs will register shortcuts separately, so will return
        //zoom processors need a live window instance; the universal path filters zoom out above
        case 'zoom_in':
          if (!window) return
          globalShortcut.register('CommandOrControl+=', () => handler(window))
          globalShortcut.register('CommandOrControl+numadd', () => handler(window))
          return

        case 'zoom_out':
          if (!window) return
          globalShortcut.register('CommandOrControl+-', () => handler(window))
          globalShortcut.register('CommandOrControl+numsub', () => handler(window))
          return

        case 'zoom_reset':
          if (!window) return
          globalShortcut.register('CommandOrControl+0', () => handler(window))
          return
      }

      const accelerator = convertShortcutFormat(shortcut.shortcut)

      globalShortcut.register(accelerator, () => handler(window as BrowserWindow))
    } catch (error) {
      logger.warn(`Failed to register shortcut ${shortcut.key}`)
    }
  })
}

/**
 * 无条件注册全局通用快捷键（show_app / mini_window）。
 *
 * 背景：快捷键注册原只有两条路径——boot 时主窗 ready-to-show（读当时的主进程
 * 配置，可能为空/陈旧）与主窗 focus。开机自启 + 启动隐藏到托盘场景下主窗永不
 * 获焦，BootConfigSync 把 redux 真相推平到主进程后，Shortcuts_Update 的重注册
 * 又被 isFocused 门死，导致快捷助手在用户手动打开一次主界面之前始终呼不出。
 * 此入口不依赖焦点，由 Shortcuts_Update 在窗口未聚焦时调用，使配置落定后
 * 全局键立即可用。
 */
export function registerUniversalShortcuts() {
  const mainWindow = windowService.getMainWindow()
  if (mainWindow && mainWindow.isDestroyed()) {
    return
  }
  registerInternal(mainWindow, true)
}

export function registerShortcuts(window: BrowserWindow) {
  if (isRegisterOnBoot) {
    window.once('ready-to-show', () => {
      if (configManager.getLaunchToTray()) {
        registerInternal(window, true)
      }
    })
    isRegisterOnBoot = false
  }

  const unregister = () => {
    if (window.isDestroyed()) return

    try {
      globalShortcut.unregisterAll()

      if (showAppAccelerator) {
        const handler = getShortcutHandler({ key: 'show_app' } as Shortcut)
        const accelerator = convertShortcutFormat(showAppAccelerator)
        handler && globalShortcut.register(accelerator, () => handler(window))
      }

      if (showMiniWindowAccelerator) {
        const handler = getShortcutHandler({ key: 'mini_window' } as Shortcut)
        const accelerator = convertShortcutFormat(showMiniWindowAccelerator)
        handler && globalShortcut.register(accelerator, () => handler(window))
      }
    } catch (error) {
      logger.warn('Failed to unregister shortcuts')
    }
  }

  // only register the event handlers once
  if (undefined === windowOnHandlers.get(window)) {
    // pass register() directly to listener, the func will receive Event as argument, it's not expected
    const registerHandler = () => {
      registerInternal(window, false)
    }
    window.on('focus', registerHandler)
    window.on('blur', unregister)
    windowOnHandlers.set(window, { onFocusHandler: registerHandler, onBlurHandler: unregister })
  }

  if (!window.isDestroyed() && window.isFocused()) {
    registerInternal(window, false)
  }
}

export function unregisterAllShortcuts() {
  try {
    showAppAccelerator = null
    showMiniWindowAccelerator = null
    windowOnHandlers.forEach((handlers, window) => {
      window.off('focus', handlers.onFocusHandler)
      window.off('blur', handlers.onBlurHandler)
    })
    windowOnHandlers.clear()
    globalShortcut.unregisterAll()
  } catch (error) {
    logger.warn('Failed to unregister all shortcuts')
  }
}
