/**
 * 翻译页类型（v0.3.3 批次3）：历史记录行（Dexie translate_records 表）与语言选择状态。
 */
import type { TranslateLangCode } from '../config/translateLanguages'

/** 任意语言码 = 内置码或用户自定义码（自定义码为任意字符串，V2 PersistedLangCode 同语义）。 */
export type AnyTranslateLangCode = TranslateLangCode | (string & {})

/** 用户自定义语言（v0.4.7 偏好项回补；store.settings.translateCustomLanguages）。 */
export interface CustomTranslateLanguage {
  langCode: string
  /** 展示名（用户语言书写）。 */
  value: string
  emoji: string
}

/** 翻译历史记录（Dexie translate_records 表行；v15 起用，旧 translate_history 已在 v11 删除）。 */
export interface TranslateRecord {
  id: string
  sourceText: string
  targetText: string
  sourceLanguage: AnyTranslateLangCode | 'auto'
  targetLanguage: AnyTranslateLangCode
  createdAt: number
}

/** 语言选择状态：源语言 'auto' = 自动检测。 */
export interface TranslateLanguageSelection {
  source: AnyTranslateLangCode | 'auto'
  target: AnyTranslateLangCode
}

/**
 * 消息级原地翻译的本地持久行（Dexie message_translations 表，v17 起用）。
 * 渲染层旁路的本地增强（V1 形态：译文作为附加块存本地，不入内核会话日志）；
 * messageId 主键 = 每条消息至多一个译文（上游 getTranslationUpdater 复用首个翻译块的窄化语义）。
 */
export interface MessageTranslationRecord {
  messageId: string
  content: string
  targetLanguage: TranslateLangCode
  updatedAt: string
}
