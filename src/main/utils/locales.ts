import { configManager } from '@main/services/ConfigManager'
import { defaultLanguage } from '@shared/config/constant'

// v0.2.4-1：机翻语言包已整体移除，只保留 zh-CN / en-US
import EnUs from '../../renderer/src/i18n/locales/en-us.json'
import ZhCn from '../../renderer/src/i18n/locales/zh-cn.json'

const locales = Object.fromEntries(
  [
    ['en-US', EnUs],
    ['zh-CN', ZhCn]
  ].map(([locale, translation]) => [locale, { translation }])
)

export type MainLocaleBundle = { translation: Record<string, unknown> }

/**
 * 取当前语言的文案包，**永不返回 undefined**。
 *
 * 为什么需要兜底：主进程多处直接对象取值（`const { tray } = locale.translation`），
 * 一旦 `configManager.getLanguage()` 返回的值不在表里（例如旧版本持久化过已删除的语言、
 * 或系统 locale 形如 `zh-Hans-CN`），旧写法会在**启动序列内抛错**并连带跳过其后的
 * `registerShortcuts()` / `registerIpc()` —— 表现为快捷键失效、窗口关闭按钮与大量 IPC 全部失灵。
 * 这里按 当前语言 → defaultLanguage → en-US → 首个可用语言 逐级回退。
 */
function getLocale(): MainLocaleBundle {
  const requested = configManager.getLanguage()
  return (
    (locales[requested] as MainLocaleBundle | undefined) ??
    (locales[defaultLanguage] as MainLocaleBundle | undefined) ??
    (locales['en-US'] as MainLocaleBundle | undefined) ??
    (Object.values(locales)[0] as MainLocaleBundle)
  )
}

/**
 * Get translation by key path (e.g., 'dialog.save_file')
 * This is a simplified version for main process, similar to i18next's t() function
 */
const t = (key: string): string => {
  const keys = key.split('.')
  let result: any = getLocale().translation
  for (const k of keys) {
    result = result?.[k]
    if (result === undefined) {
      return key
    }
  }
  return typeof result === 'string' ? result : key
}

export { locales, getLocale, t }
