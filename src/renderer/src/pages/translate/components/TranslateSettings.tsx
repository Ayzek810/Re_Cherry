/**
 * 设置抽屉（V2 TranslateSettings.tsx 的抽屉形态 + fork 现有内容）：翻译模型选择、
 * 自动复制开关、自定义翻译指令、自定义语言管理（v0.4.7 偏好项回补，V2
 * feature.translate.page.* / translateLanguages 的 fork redux 对位）。
 */
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { BUILTIN_TRANSLATE_LANGUAGES } from '@renderer/config/translateLanguages'
import { getModelUniqId } from '@renderer/services/ModelService'
import { useAppSelector } from '@renderer/store'
import { setTranslatePreferences } from '@renderer/store/settings'
import type { Model } from '@renderer/types'
import type { CustomTranslateLanguage } from '@renderer/types/translate'
import { TRANSLATE_PROMPT, validateCustomLanguage } from '@renderer/utils/translate'
import { Button, Drawer, Input, Select, Switch } from 'antd'
import { Plus, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDispatch } from 'react-redux'

const PROMPT_PLACEHOLDERS = ['🌐', '🇺🇸', '🇬🇧', '🇨🇳', '🇯🇵', '🇰🇷', '🇫🇷', '🇩🇪', '🇪🇸', '🇧🇷']

type Props = {
  visible: boolean
  model?: Model
  onClose: () => void
  onSelectModel: () => void
}

const TranslateSettings: FC<Props> = ({ visible, model, onClose, onSelectModel }) => {
  const { t } = useTranslation()
  const dispatch = useDispatch()
  const autoCopy = useAppSelector((state) => state.settings.translateAutoCopy)
  const customPrompt = useAppSelector((state) => state.settings.translateCustomPrompt)
  const customLanguages = useAppSelector((state) => state.settings.translateCustomLanguages)

  // 自定义指令本地草稿（失焦/重置即存，V2 TranslatePromptField 的 commit 语义简化版）
  const [promptDraft, setPromptDraft] = useState<string | null>(null)
  const promptValue = promptDraft ?? customPrompt
  const isPromptDefault = promptValue.trim().length === 0 || promptValue === TRANSLATE_PROMPT

  // 自定义语言新增表单
  const [adding, setAdding] = useState(false)
  const [newEmoji, setNewEmoji] = useState('🌐')
  const [newValue, setNewValue] = useState('')
  const [newCode, setNewCode] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const persist = (patch: {
    translateAutoCopy?: boolean
    translateCustomPrompt?: string
    translateCustomLanguages?: CustomTranslateLanguage[]
  }) => dispatch(setTranslatePreferences(patch))

  const commitPrompt = (next: string) => {
    setPromptDraft(next)
  }

  const savePrompt = () => {
    if (promptDraft === null) return
    persist({ translateCustomPrompt: promptDraft })
  }

  const resetPrompt = () => {
    setPromptDraft('')
    persist({ translateCustomPrompt: '' })
  }

  const handleAdd = () => {
    const result = validateCustomLanguage(newValue, newCode, BUILTIN_CODE_SET, customLanguages)
    if (!result.ok) {
      setAddError(t(`translate.custom_error.${result.reason}`))
      return
    }
    persist({
      translateCustomLanguages: [
        ...customLanguages,
        { langCode: result.langCode, value: result.value, emoji: newEmoji }
      ]
    })
    setNewValue('')
    setNewCode('')
    setNewEmoji('🌐')
    setAddError(null)
    setAdding(false)
  }

  const handleRemove = (langCode: string) => {
    persist({ translateCustomLanguages: customLanguages.filter((lang) => lang.langCode !== langCode) })
  }

  return (
    <Drawer open={visible} onClose={onClose} placement="right" width={360} title={t('translate.settings')}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t('translate.model')}</span>
          <button
            type="button"
            onClick={onSelectModel}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
            {model ? (
              <>
                <ModelAvatar model={model} size={20} />
                <span className="max-w-40 truncate">{model.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{t('translate.select_model')}</span>
            )}
          </button>
        </div>
        {model && (
          <p className="text-foreground-tertiary text-xs break-all">
            {t('translate.model_hint_prefix')}
            {getModelUniqId(model)}
          </p>
        )}

        {/* 自动复制（V2 feature.translate.page.auto_copy） */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t('translate.prefs.auto_copy')}</span>
          <Switch size="small" checked={autoCopy} onChange={(checked) => persist({ translateAutoCopy: checked })} />
        </div>

        {/* 自定义翻译指令（V2 feature.translate.model_prompt；空 = 内置） */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{t('translate.prefs.prompt')}</span>
            {!isPromptDefault && (
              <button
                type="button"
                onClick={resetPrompt}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 transition-colors hover:underline focus-visible:outline-none">
                {t('common.reset')}
              </button>
            )}
          </div>
          <Input.TextArea
            value={promptValue}
            onChange={(event) => commitPrompt(event.target.value)}
            onBlur={savePrompt}
            placeholder={t('translate.prefs.prompt_placeholder')}
            autoSize={{ minRows: 4, maxRows: 10 }}
          />
          <p className="text-foreground-tertiary text-xs">{t('translate.prefs.prompt_hint')}</p>
        </div>

        {/* 自定义语言（V2 translateLanguages 注册表的 fork redux 对位） */}
        <div className="flex flex-col gap-2">
          <span className="text-sm">{t('translate.prefs.custom_languages')}</span>
          {customLanguages.map((lang) => (
            <div key={lang.langCode} className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {lang.emoji} {lang.value}
              </span>
              <span className="text-foreground-tertiary font-mono text-xs">{lang.langCode}</span>
              <Button
                type="text"
                size="small"
                danger
                icon={<Trash2 size={13} />}
                aria-label={t('common.delete')}
                onClick={() => handleRemove(lang.langCode)}
              />
            </div>
          ))}
          {adding ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-2">
              <div className="flex gap-2">
                <Select
                  value={newEmoji}
                  onChange={setNewEmoji}
                  options={PROMPT_PLACEHOLDERS.map((emoji) => ({ value: emoji, label: emoji }))}
                  className="w-20"
                  aria-label={t('translate.custom_error.emoji')}
                />
                <Input
                  value={newValue}
                  onChange={(event) => setNewValue(event.target.value)}
                  placeholder={t('translate.custom_value')}
                />
              </div>
              <Input
                value={newCode}
                onChange={(event) => setNewCode(event.target.value)}
                placeholder={t('translate.custom_code')}
              />
              {addError && <p className="text-destructive text-xs">{addError}</p>}
              <div className="flex justify-end gap-2">
                <Button size="small" onClick={() => setAdding(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="primary" size="small" onClick={handleAdd}>
                  {t('common.add')}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="dashed" size="small" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              {t('translate.prefs.add_language')}
            </Button>
          )}
          <p className="text-foreground-tertiary text-xs">{t('translate.prefs.custom_hint')}</p>
        </div>
      </div>
    </Drawer>
  )
}

const BUILTIN_CODE_SET = new Set<string>(BUILTIN_TRANSLATE_LANGUAGES.map((lang) => lang.langCode))

export default TranslateSettings
