import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron, test as base } from '@playwright/test'

/**
 * Custom fixtures for Electron e2e testing.
 * Provides electronApp and mainWindow to all tests.
 */
export type ElectronFixtures = {
  electronApp: ElectronApplication
  mainWindow: Page
}

export const test = base.extend<ElectronFixtures>({
  electronApp: async ({}, use) => {
    // Launch Electron app from project root
    // The args ['.'] tells Electron to load the app from current directory
    const electronApp = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'development'
      },
      timeout: 60000
    })

    await use(electronApp)

    // Cleanup: close the app after test
    await electronApp.close()
  },

  mainWindow: async ({ electronApp }, use) => {
    // Wait for the main window (title: "Re_Cherry", not "Quick Assistant").
    //
    // 2026-10-01：不能在 attach 之后才 `waitForEvent('window')`。主进程在 Playwright 连上 CDP
    // 之前就已经把主窗口建好了，事件错过 ⇒ 整族用例 60s 超时（当时 7/7 全红，而应用实际渲染正常）。
    // 正确顺序：先看**已存在**的窗口，找不到再等新窗口事件。
    const titleOf = async (win: Page): Promise<string> => {
      try {
        return await win.title()
      } catch {
        return '' // 窗口还在初始化，按不匹配处理
      }
    }

    let mainWindow: Page | undefined
    for (const win of electronApp.windows()) {
      if ((await titleOf(win)) === 'Re_Cherry') {
        mainWindow = win
        break
      }
    }
    if (!mainWindow) {
      mainWindow = await electronApp.waitForEvent('window', {
        predicate: async (win) => (await titleOf(win)) === 'Re_Cherry',
        timeout: 60000
      })
    }

    // Wait for React app to mount
    await mainWindow.waitForSelector('#root', { state: 'attached', timeout: 60000 })

    // Wait for initial content to load
    await mainWindow.waitForLoadState('domcontentloaded')

    await use(mainWindow)
  }
})

export { expect } from '@playwright/test'
