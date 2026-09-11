import 'dayjs/locale/zh-cn'

import { loggerService } from '@logger'
import { defaultLanguage } from '@shared/config/constant'
import dayjs from 'dayjs'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Original translation（v0.2.4-1：机翻语言包已整体移除，只保留 zh-CN / en-US）
import enUS from './locales/en-us.json'
import zhCN from './locales/zh-cn.json'

const logger = loggerService.withContext('I18N')

const resources = Object.fromEntries(
  [
    ['en-US', enUS],
    ['zh-CN', zhCN]
  ].map(([locale, translation]) => [locale, { translation }])
)

export const getLanguage = () => {
  return localStorage.getItem('language') || navigator.language || defaultLanguage
}

export const getLanguageCode = () => {
  return getLanguage().split('-')[0]
}

// Map i18n language codes to dayjs locale codes
const dayjsLocaleMap: Record<string, string> = {
  'en-US': 'en',
  'zh-CN': 'zh-cn'
}

export const setDayjsLocale = (language: string) => {
  const dayjsLocale = dayjsLocaleMap[language] || 'en'
  dayjs.locale(dayjsLocale)
}

void i18n.use(initReactI18next).init({
  resources,
  lng: getLanguage(),
  fallbackLng: defaultLanguage,
  interpolation: {
    escapeValue: false
  },
  saveMissing: true,
  missingKeyHandler: (_1, _2, key) => {
    logger.error(`Missing key: ${key}`)
  }
})

export default i18n
