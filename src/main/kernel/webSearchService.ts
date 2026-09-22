/**
 * 网络搜索服务缝（ctx.webSearch，批次2）。
 *
 * 持两份状态：渲染层 websearch 切片的同步投影（providers 含 apiKey / blacklist /
 * searchWithTime，Dsh_SyncWebSearch 推送）与"每轮搜索提供商"登记（topics.sendMessage
 * 按发送参数写入，web_search 工具执行时读取）。apiKey 只进主进程内存，不落内核
 * settings.json（配置文件服务不感知本缝）。
 *
 * 搜索执行本体在主进程服务 ../services/WebSearchService（引擎单例 webSearchService：
 * provider 分派 / 黑名单过滤 / local-* 刮取），本缝只承担 cordis 声明制的落位与
 * 配置、每轮上下文的转交——工具执行直用引擎单例，不经本缝。
 *
 * 落缝方式：cordis `Service` 子类（`super(ctx, 'webSearch')`），与 imageDescriber
 * 同教义——直接给 ctx 赋属性会被 cordis 4 的声明制拒绝。
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'
import type { KernelWebSearchConfig } from '@shared/config/types'

import { webSearchService } from '../services/WebSearchService'

const logger = loggerService.withContext('WebSearchKernel')

/** ctx.webSearch 服务形状（IPC handler 与 topics.ts 消费）。 */
export class WebSearchKernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'webSearch')
  }

  /** 渲染层 websearch 切片 → 引擎配置投影（整体替换，启动与切片变更时各推一次）。 */
  setConfig(config: KernelWebSearchConfig): void {
    webSearchService.setConfig(config)
    logger.info('web search config updated', {
      providers: config.providers.length,
      blacklistPatterns: config.blacklist.length,
      searchWithTime: config.searchWithTime
    })
  }

  /**
   * 每轮搜索提供商登记：topics.sendMessage 按发送参数写入（undefined = 本轮未启用
   * 网络搜索，web_search 工具此时不该被调，执行侧防线拒答）。即设即覆盖，无清理
   * 需求——工具只在挂载轮可被调，下一轮发送会重写或置空。
   */
  setTurnProvider(topicId: string, providerId: string | undefined): void {
    webSearchService.setTurnProvider(topicId, providerId)
  }
}

logger.debug('web search kernel service module loaded')
