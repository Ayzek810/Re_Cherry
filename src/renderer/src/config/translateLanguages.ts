/**
 * 翻译内置语言表（V2 presets/translateLanguages.ts 薄适配版）：branded type 与
 * parsePersistedLangCode 机制随 V2 preference 系统出局，降为纯数据 + 字面量联合。
 * 形状/顺序/emoji 与 V2 逐字一致；langCodeToI18nKey 同 V2（fork i18n languages.* 键族）。
 */

export type TranslateLangCode =
  | 'en-us'
  | 'zh-cn'
  | 'zh-tw'
  | 'ja-jp'
  | 'ko-kr'
  | 'fr-fr'
  | 'de-de'
  | 'it-it'
  | 'es-es'
  | 'pt-pt'
  | 'ru-ru'
  | 'pl-pl'
  | 'ar-sa'
  | 'tr-tr'
  | 'th-th'
  | 'vi-vn'
  | 'id-id'
  | 'ur-pk'
  | 'ms-my'
  | 'uk-ua'

export interface TranslateLanguage {
  langCode: TranslateLangCode
  value: string
  emoji: string
}

/** V2 BUILTIN_LANGUAGE 同款 20 语言（顺序即 UI 呈现序）。 */
export const BUILTIN_LANGUAGE = {
  enUS: { langCode: 'en-us', value: 'English', emoji: '🇺🇸' },
  zhCN: { langCode: 'zh-cn', value: 'Chinese (Simplified)', emoji: '🇨🇳' },
  zhTW: { langCode: 'zh-tw', value: 'Chinese (Traditional)', emoji: '🇭🇰' },
  jaJP: { langCode: 'ja-jp', value: 'Japanese', emoji: '🇯🇵' },
  koKR: { langCode: 'ko-kr', value: 'Korean', emoji: '🇰🇷' },
  frFR: { langCode: 'fr-fr', value: 'French', emoji: '🇫🇷' },
  deDE: { langCode: 'de-de', value: 'German', emoji: '🇩🇪' },
  itIT: { langCode: 'it-it', value: 'Italian', emoji: '🇮🇹' },
  esES: { langCode: 'es-es', value: 'Spanish', emoji: '🇪🇸' },
  ptPT: { langCode: 'pt-pt', value: 'Portuguese', emoji: '🇵🇹' },
  ruRU: { langCode: 'ru-ru', value: 'Russian', emoji: '🇷🇺' },
  plPL: { langCode: 'pl-pl', value: 'Polish', emoji: '🇵🇱' },
  arSA: { langCode: 'ar-sa', value: 'Arabic', emoji: '🇸🇦' },
  trTR: { langCode: 'tr-tr', value: 'Turkish', emoji: '🇹🇷' },
  thTH: { langCode: 'th-th', value: 'Thai', emoji: '🇹🇭' },
  viVN: { langCode: 'vi-vn', value: 'Vietnamese', emoji: '🇻🇳' },
  idID: { langCode: 'id-id', value: 'Indonesian', emoji: '🇮🇩' },
  urPK: { langCode: 'ur-pk', value: 'Urdu', emoji: '🇵🇰' },
  msMY: { langCode: 'ms-my', value: 'Malay', emoji: '🇲🇾' },
  ukUA: { langCode: 'uk-ua', value: 'Ukrainian', emoji: '🇺🇦' }
} as const satisfies Record<string, TranslateLanguage>

export const BUILTIN_TRANSLATE_LANGUAGES: TranslateLanguage[] = Object.values(BUILTIN_LANGUAGE)

/** langCode → i18n 键（V2 同款；fork i18n languages.* 键族）。 */
export const langCodeToI18nKey = new Map<string, string>(
  Object.entries({
    'en-us': 'languages.english',
    'zh-cn': 'languages.chinese',
    'zh-tw': 'languages.chinese-traditional',
    'ja-jp': 'languages.japanese',
    'ko-kr': 'languages.korean',
    'fr-fr': 'languages.french',
    'de-de': 'languages.german',
    'it-it': 'languages.italian',
    'es-es': 'languages.spanish',
    'pt-pt': 'languages.portuguese',
    'ru-ru': 'languages.russian',
    'pl-pl': 'languages.polish',
    'ar-sa': 'languages.arabic',
    'tr-tr': 'languages.turkish',
    'th-th': 'languages.thai',
    'vi-vn': 'languages.vietnamese',
    'id-id': 'languages.indonesian',
    'ur-pk': 'languages.urdu',
    'ms-my': 'languages.malay',
    'uk-ua': 'languages.ukrainian',
    unknown: 'languages.unknown'
  })
)
