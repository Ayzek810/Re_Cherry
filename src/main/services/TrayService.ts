import { isLinux, isMac, isWin } from '@main/constant'
import { getLocale } from '@main/utils/locales'
import type { MenuItemConstructorOptions } from 'electron'
import { app, Menu, nativeImage, nativeTheme, Tray } from 'electron'

import icon from '../../../build/tray_icon.png?asset'
import iconDark from '../../../build/tray_icon_dark.png?asset'
import iconLight from '../../../build/tray_icon_light.png?asset'
import { ConfigKeys, configManager } from './ConfigManager'
import { windowService } from './WindowService'

export class TrayService {
  private static instance: TrayService
  private tray: Tray | null = null
  private contextMenu: Menu | null = null

  constructor() {
    this.watchConfigChanges()
    this.updateTray()
    TrayService.instance = this
  }

  public static getInstance() {
    return TrayService.instance
  }

  private createTray() {
    this.destroyTray()

    const iconPath = isMac ? (nativeTheme.shouldUseDarkColors ? iconLight : iconDark) : icon
    const tray = new Tray(iconPath)

    if (isWin) {
      tray.setImage(iconPath)
    } else if (isMac) {
      const image = nativeImage.createFromPath(iconPath)
      const resizedImage = image.resize({ width: 16, height: 16 })
      resizedImage.setTemplateImage(true)
      tray.setImage(resizedImage)
    } else if (isLinux) {
      const image = nativeImage.createFromPath(iconPath)
      const resizedImage = image.resize({ width: 16, height: 16 })
      tray.setImage(resizedImage)
    }

    this.tray = tray

    this.updateContextMenu()

    this.tray.setToolTip('Re_Cherry')

    this.tray.on('right-click', () => {
      if (this.contextMenu) {
        this.tray?.popUpContextMenu(this.contextMenu)
      }
    })

    this.tray.on('click', () => {
      if (configManager.getEnableQuickAssistant() && configManager.getClickTrayToShowQuickAssistant()) {
        windowService.showMiniWindow()
      } else {
        windowService.showMainWindow()
      }
    })
  }

  private updateContextMenu() {
    const locale = getLocale()
    const { tray: trayLocale } = locale.translation

    const quickAssistantEnabled = configManager.getEnableQuickAssistant()

    const template = [
      {
        label: trayLocale.show_window,
        click: () => windowService.showMainWindow()
      },
      quickAssistantEnabled && {
        label: trayLocale.show_mini_window,
        click: () => windowService.showMiniWindow()
      },
      { type: 'separator' },
      {
        label: trayLocale.quit,
        click: () => this.quit()
      }
    ].filter(Boolean) as MenuItemConstructorOptions[]

    this.contextMenu = Menu.buildFromTemplate(template)
    // 所有平台都把菜单原生挂到托盘上：Explorer/Dock 收到右键即出菜单，
    // 无需依赖 'right-click' 事件 + popUpContextMenu 的手动弹窗路径——
    // Electron 41 + Win11 上 popUpContextMenu 在 'right-click' 句柄里弹出
    // 不可靠（表现为右键无任何反应，2026-09-17 用户端事故）。
    // 此前只有 Linux 挂载，且挂载后语言/开关变化从不重挂，Win/mac 一直
    // 靠易碎的 popUp 路径；现在统一挂载并在每次模板重建后重挂。
    this.tray?.setContextMenu(this.contextMenu)
  }

  private updateTray() {
    const showTray = configManager.getTray()
    if (showTray) {
      this.createTray()
    } else {
      this.destroyTray()
    }
  }

  private destroyTray() {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  private watchConfigChanges() {
    configManager.subscribe(ConfigKeys.Tray, () => this.updateTray())

    configManager.subscribe(ConfigKeys.Language, () => {
      this.updateContextMenu()
    })

    configManager.subscribe(ConfigKeys.EnableQuickAssistant, () => {
      this.updateContextMenu()
    })
  }

  private quit() {
    app.quit()
  }
}
