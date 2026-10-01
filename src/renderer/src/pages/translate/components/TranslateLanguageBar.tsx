/**
 * 顶栏语言栏（V2 components/TranslateLanguageBar.tsx 结构）：源语言 / 交换 / 目标语言。
 * V2 的 Combobox + useLanguages 换成 fork 的 antd Select + 内置语言表；
 * 语言文案由页面注入的 languageLabel 提供（fork i18n languages.* 键族）。
 * 自定义语言（AnyTranslateLangCode）与内置同列表渲染，customLabel 提供文案。
 */
import { BUILTIN_TRANSLATE_LANGUAGES, type TranslateLangCode } from '@renderer/config/translateLanguages'
import type { AnyTranslateLangCode, CustomTranslateLanguage } from '@renderer/types/translate'
import { cn } from '@renderer/utils/style'
import { Select, Tooltip } from 'antd'
import { ArrowLeftRight } from 'lucide-react'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  className?: string
  source: AnyTranslateLangCode | 'auto'
  onSourceChange: (value: AnyTranslateLangCode | 'auto') => void
  target: AnyTranslateLangCode
  onTargetChange: (value: AnyTranslateLangCode) => void
  /** V1 语义（`TranslatePage.tsx:743-745`）：auto 源语言检测到的实际语言，追加在自动检测项后。 */
  detectedLanguage?: TranslateLangCode | null
  languageLabel: (code: AnyTranslateLangCode | 'auto') => string
  /** 自定义语言（追加在内置之后；空 = 无）。 */
  customLanguages: CustomTranslateLanguage[]
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
  detectedLanguage,
  languageLabel,
  customLanguages,
  exchangeDisabled,
  onExchange
}) => {
  const { t } = useTranslation()

  const languageOptions = useMemo(
    () => [
      ...BUILTIN_TRANSLATE_LANGUAGES.map((lang) => ({
        value: lang.langCode,
        label: `${lang.emoji} ${languageLabel(lang.langCode)}`
      })),
      ...customLanguages.map((lang) => ({
        value: lang.langCode,
        label: `${lang.emoji} ${lang.value}`
      }))
    ],
    [customLanguages, languageLabel]
  )

  /** V1 `TranslatePage.tsx:743-745`：自动检测项的文案是 `自动检测 (检测到的语言)`。 */
  const sourceOptions = useMemo(
    () => [
      {
        value: 'auto' as const,
        label: `🌐 ${languageLabel('auto')}${detectedLanguage ? ` (${languageLabel(detectedLanguage)})` : ''}`
      },
      ...languageOptions
    ],
    [detectedLanguage, languageLabel, languageOptions]
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
        onChange={(value) => onSourceChange(value as AnyTranslateLangCode | 'auto')}
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
          待对齐 V2 的检测语言显示（检测引擎未移植）。 */}
      <Select
        className={LANGUAGE_SELECT_CLASS}
        value={target}
        options={languageOptions}
        onChange={(value) => onTargetChange(value as AnyTranslateLangCode)}
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={false}
        aria-label={t('translate.target_language')}
      />
    </div>
  )
}

export default TranslateLanguageBar
