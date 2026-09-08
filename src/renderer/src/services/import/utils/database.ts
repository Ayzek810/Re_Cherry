import { loggerService } from '@logger'

import type { ImportResult } from '../types'

const logger = loggerService.withContext('ImportDatabase')

/**
 * Save import result to database.
 *
 * Dexie 已废弃 + 旧数据政策：导入的消息不再写入本地存储。
 * 话题骨架由 ImportService 加入 Redux；导入的消息如需可用，需后续迁移到 dsh 内核会话。
 */
export async function saveImportToDatabase(result: ImportResult): Promise<void> {
  const { topics, messages, blocks } = result

  logger.warn(
    `Import: skipping message persistence (${topics.length} topics, ${messages.length} messages, ${blocks.length} blocks) — legacy storage retired`
  )
}
