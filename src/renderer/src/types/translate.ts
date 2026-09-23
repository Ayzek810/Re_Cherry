/**
 * 翻译页类型（v0.3.3 批次3）：历史记录行（Dexie translate_records 表）与语言选择状态。
 */
import type { TranslateLangCode } from '../config/translateLanguages'

/** 翻译历史记录（Dexie translate_records 表行；v15 起用，旧 translate_history 已在 v11 删除）。 */
export interface TranslateRecord {
  id: string
  sourceText: string
  targetText: string
  sourceLanguage: TranslateLangCode | 'auto'
  targetLanguage: TranslateLangCode
  createdAt: number
}

/** 语言选择状态：源语言 'auto' = 自动检测。 */
export interface TranslateLanguageSelection {
  source: TranslateLangCode | 'auto'
  target: TranslateLangCode
}
