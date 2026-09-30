import { loggerService } from '@logger'
import { parseMatchPattern } from '@shared/utils/matchPattern'

const logger = loggerService.withContext('BlacklistMatchPattern')

// ublacklist match pattern 核心已收口到 shared（主进程 webSearchProviders 同源引用），
// 此处只保留渲染层订阅源解析，并转发 parseMatchPattern 维持既有 import 面。
export { type ParsedMatchPattern,parseMatchPattern } from '@shared/utils/matchPattern'

/** 拉取订阅源内容，按行解析出合法的 ublacklist 模式串（跳过空行与 # 注释）。 */
export async function parseSubscribeContent(url: string): Promise<string[]> {
  try {
    // 获取订阅源内容
    const response = await fetch(url)
    logger.debug('[parseSubscribeContent] response', response)
    if (!response.ok) {
      throw new Error('Failed to fetch subscribe content')
    }

    const content = await response.text()

    // 按行分割内容
    const lines = content.split('\n')

    // 过滤出有效的匹配模式
    return lines
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.trim())
      .filter((pattern) => parseMatchPattern(pattern) !== null)
  } catch (error) {
    logger.error('Error parsing subscribe content:', error as Error)
    throw error
  }
}
