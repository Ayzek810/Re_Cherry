import type { Locator, Page } from '@playwright/test'

import { BasePage } from './base.page'

/**
 * Page Object for the Sidebar/Navigation component.
 * Handles navigation between different sections of the app.
 */
export class SidebarPage extends BasePage {
  readonly sidebar: Locator
  readonly homeLink: Locator
  readonly filesLink: Locator
  readonly settingsLink: Locator

  constructor(page: Page) {
    super(page)
    this.sidebar = page.locator('[class*="Sidebar"], nav, aside')
    this.homeLink = page.locator('a[href="#/"], a[href="#!/"]').first()
    this.filesLink = page.locator('a[href*="/files"]')
    this.settingsLink = page.locator('a[href*="/settings"]')
  }

  /**
   * Navigate to Home page.
   */
  async goToHome(): Promise<void> {
    // Try clicking the home link, or navigate directly
    try {
      await this.homeLink.click({ timeout: 5000 })
    } catch {
      await this.navigateTo('/')
    }
    await this.page.waitForURL(/.*#\/$|.*#$|.*#\/home.*/, { timeout: 10000 }).catch(() => {})
  }

  /**
   * Navigate to Settings page.
   */
  async goToSettings(): Promise<void> {
    try {
      await this.settingsLink.click({ timeout: 5000 })
    } catch {
      await this.navigateTo('/settings/provider')
    }
    await this.page.waitForURL('**/#/settings/**', { timeout: 10000 }).catch(() => {})
  }

  /**
   * Navigate to Files page.
   */
  async goToFiles(): Promise<void> {
    try {
      await this.filesLink.click({ timeout: 5000 })
    } catch {
      await this.navigateTo('/files')
    }
    await this.page.waitForURL('**/#/files**', { timeout: 10000 }).catch(() => {})
  }

  /**
   * Check if sidebar is visible.
   */
  async isVisible(): Promise<boolean> {
    return this.sidebar.first().isVisible()
  }
}
