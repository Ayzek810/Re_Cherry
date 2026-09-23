/**
 * 顶栏语言栏（V2 components/TranslateLanguageBar.tsx 结构）：源语言 / 交换 / 目标语言。
 * V2 的 Combobox + useLanguages 换成 fork 的 antd Select + 内置语言表；
 * 语言文案由页面注入的 languageLabel 提供（fork i18n languages.* 键族）。
 */
import { BUILTIN_TRANSLATE_LANGUAGES, type TranslateLangCode } from '@renderer/config/translateLanguages'
import { cn } from '@renderer/utils/style'
import { Select, Tooltip } from 'antd'
import { ArrowLeftRight } from 'lucide-react'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  className?: string
  source: TranslateLangCode | 'auto'
  onSourceChange: (value: TranslateLangCode | 'auto') => void
  target: TranslateLangCode
  onTargetChange: (value: TranslateLangCode) => void
  languageLabel: (code: TranslateLangCode | 'auto') => string
  exchangeDisabled: boolean
  onExchange: () => void
}

const LANGUAGE_SELECT_CLASS = 'h-8 w-42 shrink-0'

const TranslateLanguageBar: FC<Props> = ({
  className,
  source,
  onSourceChange,
  target,
  onTargetChange,
  languageLabel,
  exchangeDisabled,
  onExchange
}) => {
  const { t } = useTranslation()

  const languageOptions = useMemo(
    () =>
      BUILTIN_TRANSLATE_LANGUAGES.map((lang) => ({
        value: lang.langCode,
        label: `${lang.emoji} ${languageLabel(lang.langCode)}`
      })),
    [languageLabel]
  )

  const sourceOptions = useMemo(
    () => [{ value: 'auto' as const, label: `🌐 ${languageLabel('auto')}` }, ...languageOptions],
    [languageLabel, languageOptions]
  )

  return (
    <div className={cn('flex min-w-0 shrink-0 items-center gap-3', className)}>
      {/* fork 缝：V2:162-171 在源语言 Combobox 的取值渲染里带一个 `sr-only` 的
          `translate.source_language` 标签。fork 的 antd Select 没有 renderValue 插槽，
          改用 Select 的 `aria-label`（rc-select 的 props 继承 React.AriaAttributes，
          落在可访问性根上）达到同一"控件有名字"的效果。 */}
      <Select
        className={LANGUAGE_SELECT_CLASS}
        value={source}
        options={sourceOptions}
        onChange={(value) => onSourceChange(value as TranslateLangCode | 'auto')}
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={false}
        aria-label={t('translate.source_language')}
      />
      <Tooltip title={t('translate.exchange')}>
        <button
          type="button"
          onClick={onExchange}
          disabled={exchangeDisabled}
          aria-label={t('translate.exchange')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none active:scale-90 disabled:cursor-not-allowed disabled:opacity-60">
          <ArrowLeftRight size={14} className="lucide-custom" />
        </button>
      </Tooltip>
      {/* fork 缝：V2:218-227 同样在目标语言 Combobox 的取值渲染里带 `sr-only` 的
          `translate.target_language` 标签，fork 改用 `aria-label`（同源语言）。
          仍缺一项：V2 还会把**检测到的语言**显示在源语言取值处，fork 无检测引擎
          （V2 走 `franc-min` + `useDetectLang`，fork 无该依赖）——保留"自动检测"占位，
          见 `未清债.md`。 */}
      <Select
        className={LANGUAGE_SELECT_CLASS}
        value={target}
        options={languageOptions}
        onChange={(value) => onTargetChange(value as TranslateLangCode)}
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={false}
        aria-label={t('translate.target_language')}
      />
    </div>
  )
}

export default TranslateLanguageBar
