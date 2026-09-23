/**
 * 历史抽屉（V2 components/TranslateHistory.tsx 结构，星标/详情/清空/文件支路删除）：
 * antd Drawer(placement=right) + 行列表 + 点击回填。数据由页面注入，组件只做展示与回调。
 */
import { BUILTIN_TRANSLATE_LANGUAGES, type TranslateLangCode } from '@renderer/config/translateLanguages'
import type { TranslateRecord } from '@renderer/types/translate'
import { Drawer, Empty } from 'antd'
import { ArrowRight } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  isOpen: boolean
  items: TranslateRecord[]
  languageLabel: (code: TranslateLangCode | 'auto') => string
  onClose: () => void
  onHistoryItemClick: (record: TranslateRecord) => void
}

const LANGUAGE_EMOJI = new Map<string, string>(BUILTIN_TRANSLATE_LANGUAGES.map((lang) => [lang.langCode, lang.emoji]))
const AUTO_EMOJI = '🌐'
const UNKNOWN_EMOJI = '🏳️'

const formatCreatedAt = (value: number, locale: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isSameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  if (isSameDay) return time
  return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)} ${time}`
}

const TranslateHistoryList: FC<Props> = ({ isOpen, items, languageLabel, onClose, onHistoryItemClick }) => {
  const { t, i18n } = useTranslation()

  const emojiOf = (code: TranslateLangCode | 'auto') =>
    code === 'auto' ? AUTO_EMOJI : (LANGUAGE_EMOJI.get(code) ?? UNKNOWN_EMOJI)

  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      placement="right"
      width={360}
      title={t('translate.history')}
      styles={{ body: { paddingTop: 12 } }}>
      {items.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center">
          <Empty description={t('translate.history_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onHistoryItemClick(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onHistoryItemClick(item)
                }
              }}
              className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md p-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-muted px-1 py-px text-muted-foreground text-sm">
                  {emojiOf(item.sourceLanguage)} {languageLabel(item.sourceLanguage)}
                </span>
                <ArrowRight size={8} className="shrink-0 text-foreground-tertiary" />
                <span className="rounded bg-primary/10 px-1 py-px text-primary text-sm">
                  {emojiOf(item.targetLanguage)} {languageLabel(item.targetLanguage)}
                </span>
                <span className="ml-auto shrink-0 text-foreground-tertiary text-sm">
                  {formatCreatedAt(item.createdAt, i18n.language)}
                </span>
              </div>
              <p className="line-clamp-1 text-muted-foreground text-sm">{item.sourceText}</p>
              <p className="line-clamp-1 text-foreground text-sm">{item.targetText}</p>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}

export default TranslateHistoryList
