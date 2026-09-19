import type { TokenUsageData } from '@cherrystudio/analytics-client'
import { AnalyticsClient } from '@cherrystudio/analytics-client'
import { loggerService } from '@logger'
import { generateUserAgent } from '@main/utils/systemInfo'
import { APP_NAME } from '@shared/config/constant'
import { app } from 'electron'

import { configManager } from './ConfigManager'

const logger = loggerService.withContext('AnalyticsService')

/**
 * v0.3.1-2：本 fork 是否启用上游遥测。置 false 即彻底不上报（上游通道为 `cherry-studio`）。
 * 保留上游实现代码与设置项，供将来若有自建上报端时复用。
 */
const FORK_ANALYTICS_ENABLED = false

class AnalyticsService {
  private client: AnalyticsClient | null = null
  private static instance: AnalyticsService

  public static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService()
    }
    return AnalyticsService.instance
  }

  public init(): void {
    // v0.3.1-2：本 fork **不启用**上游遥测。上游实现是"缺省开 + 隐私政策更新时强制重置为开"，
    // 且会把 app 启动 / token 用量上报到上游的 `cherry-studio` 通道；仅改默认值关不掉
    // （历史持久化与主进程 config 里可能已存 true）。故在服务层直接关闭：不建立客户端即不上报，
    // 其余上报入口（trackAppUpdate / trackTokenUsage）都已有 `!this.client` 前置守卫。
    if (!FORK_ANALYTICS_ENABLED) {
      logger.info('Analytics service disabled in this fork (upstream telemetry not used)')
      return
    }

    if (!configManager.getEnableDataCollection()) {
      logger.info('Analytics service disabled by user preference')
      return
    }

    this.client = new AnalyticsClient({
      clientId: configManager.getClientId(),
      channel: 'cherry-studio',
      onError: (error) => logger.error('Analytics error:', error),
      headers: {
        'User-Agent': generateUserAgent(),
        'Client-Id': configManager.getClientId(),
        'App-Name': APP_NAME,
        'App-Version': `v${app.getVersion()}`,
        OS: process.platform
      }
    })

    this.client.trackAppLaunch({
      version: app.getVersion(),
      os: process.platform
    })

    logger.info('Analytics service initialized')
  }

  public async trackAppUpdate(): Promise<void> {
    if (!this.client || !configManager.getEnableDataCollection()) {
      return
    }

    await this.client.trackAppUpdate()
  }

  public trackTokenUsage(data: TokenUsageData): void {
    const enableDataCollection = configManager.getEnableDataCollection()

    if (!this.client || !enableDataCollection) {
      return
    }

    this.client.trackTokenUsage(data)
  }

  public async destroy(): Promise<void> {
    if (!this.client) return
    await this.client.destroy()
    this.client = null
    logger.info('Analytics service destroyed')
  }
}

export const analyticsService = AnalyticsService.getInstance()
