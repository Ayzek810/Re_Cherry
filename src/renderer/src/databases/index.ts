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
import type {
  FileMetadata,
  KnowledgeNoteItem,
  MessageTranslationRecord,
  PaintingRecord,
  QuickPhrase,
  TranslateRecord,
  UsageRecord
} from '@renderer/types'
import { Dexie, type EntityTable } from 'dexie'

import { upgradeToV5, upgradeToV7, upgradeToV8 } from './upgrades'

// ---------------------------------------------------------------------------
// Dexie 版本纪律：**版本块只能追加，不能删除、不能合并、不能改写**。
// Dexie 用声明式版本表算升级路径：已升到 vN 的用户库，其 `_dbSchema` 里记着 vN 的表集，
// 打开时必须能从旧表集沿**声明链**走到新表集。删掉/合并任何一个中间版本块，都会让停在
// 该版本的库找不到自己的升级起点而打不开（IndexedDB 里数据还在，但应用永久无法读取）。
// 同理，已发布的版本块里 `stores({...})` 的表集合也不能再改——只能新增更高的版本块。
// 与 redux-persist 侧的迁移纪律同源（`store/migrate.ts`：分支只增不删，`store/index.ts`
// 的 version 与该文件最高键保持相等）。
// 典型案例见下方 v13/v14：v13 上线又撤销，两个版本块都必须原地保留。
// ---------------------------------------------------------------------------
// Database declaration (move this to its own module also)
export const db = new Dexie('CherryStudio', {
  chromeTransactionDurability: 'strict'
}) as Dexie & {
  files: EntityTable<FileMetadata, 'id'>
  settings: EntityTable<{ id: string; value: any }, 'id'>
  knowledge_notes: EntityTable<KnowledgeNoteItem, 'id'>
  quick_phrases: EntityTable<QuickPhrase, 'id'>
  translate_records: EntityTable<TranslateRecord, 'id'>
  paintings: EntityTable<PaintingRecord, 'id'>
  message_translations: EntityTable<MessageTranslationRecord, 'messageId'>
  usage_records: EntityTable<UsageRecord, 'id'>
}

db.version(1).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count'
})

db.version(2).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value'
})

db.version(3).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at'
})

db.version(4).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
})

db.version(5)
  .stores({
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id, messages',
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt'
  })
  .upgrade((tx) => upgradeToV5(tx))

db.version(6).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id, messages',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  quick_phrases: 'id'
})

// --- NEW VERSION 7 ---
db.version(7)
  .stores({
    // Redeclare all tables for the new version
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id', // Correct index for topics
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
  })
  .upgrade((tx) => upgradeToV7(tx))

db.version(8)
  .stores({
    // Redeclare all tables for the new version
    files: 'id, name, origin_name, path, size, ext, type, created_at, count',
    topics: '&id', // Correct index for topics
    settings: '&id, value',
    knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
    translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
    quick_phrases: 'id',
    message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
  })
  .upgrade((tx) => upgradeToV8(tx))

db.version(9).stores({
  // Redeclare all tables for the new version
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id', // Correct index for topics
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  translate_languages: '&id, langCode',
  quick_phrases: 'id',
  message_blocks: 'id, messageId, file.id' // Correct syntax with comma separator
})

db.version(10).stores({
  files: 'id, name, origin_name, path, size, ext, type, created_at, count',
  topics: '&id',
  settings: '&id, value',
  knowledge_notes: '&id, baseId, type, content, created_at, updated_at',
  translate_history: '&id, sourceText, targetText, sourceLanguage, targetLanguage, createdAt',
  translate_languages: '&id, langCode',
  quick_phrases: 'id',
  message_blocks: 'id, messageId, file.id'
})

// Translate feature removed: drop its tables
db.version(11).stores({
  translate_history: null,
  translate_languages: null
})

// Chat messages/topics moved to the dsh kernel (session storage is authoritative): drop the tables
db.version(12).stores({
  topics: null,
  message_blocks: null
})

// v13 曾短暂引入 message_files 关联表（Dexie 旁路存文档附件）——被 v14 撤销：
// 附件引用改走内核会话日志的 'document' 内容块（merge-extensible 公开扩展点，
// 见 src/renderer/src/types/kernelContentBlocks.ts），会话日志保持唯一权威（不变量2）。
db.version(13).stores({
  message_files: '&messageId, topicId'
})
db.version(14).stores({
  message_files: null
})

// 翻译页回归——历史表用新名 translate_records（translate_history
// 在 v4-v10 存在过、v11 已 drop，复用旧名会撞已删表语义）。
db.version(15).stores({
  translate_records: '&id, createdAt'
})

// 绘画页——生成历史（V2 PaintingSchema 形状收窄；文件字节落
// FileStorage，本表只存引用与元数据）。
db.version(16).stores({
  paintings: '&id, createdAt'
})

// 消息级原地翻译（V1 MessageTranslate 移植）：译文按 messageId 落本地（渲染层旁路
// 本地增强，不入内核会话日志——不变量2；对照 v13/v14 的 message_files 教训：只有需要
// 会话日志回放的数据才走日志，纯本地展示增强走 Dexie 功能表）。v12 删掉的 message_blocks
// 表不复活：译文单表单键，不承担通用块存储职责。
db.version(17).stores({
  message_translations: '&messageId'
})

// 用量统计面板：回合级 usage 记录（kernelChat 回合收尾落库）。派生分析数据
// （trace/span 同类），不是会话状态第二真相源——不变量2 允许；++id 自增主键，
// timestamp/modelId/topicId 二级索引服务时间范围与模型分组查询。
db.version(18).stores({
  usage_records: '++id, timestamp, modelId, topicId'
})

export default db
