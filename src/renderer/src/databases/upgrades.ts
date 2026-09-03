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
import type { Transaction } from 'dexie'

const logger = loggerService.withContext('Database:Upgrades')

export async function upgradeToV5(tx: Transaction): Promise<void> {
  const files = await tx.table('files').toArray()

  for (const file of files) {
    if (file.created_at instanceof Date) {
      file.created_at = file.created_at.toISOString()
      await tx.table('files').put(file)
    }
  }
}

// --- UPDATED UPGRADE FUNCTION for Version 7 ---
export async function upgradeToV7(tx: Transaction): Promise<void> {
  void tx
  // topics/message_blocks 已废弃（聊天存储迁至 dsh 内核），历史消息迁移不再执行
  logger.info('DB migration to version 7 skipped: legacy message storage retired.')
}

export async function upgradeToV8(tx: Transaction): Promise<void> {
  void tx
  // Translation feature removed; legacy translate settings/history migration dropped.
  logger.info('DB migration to version 8 finished.')
}
