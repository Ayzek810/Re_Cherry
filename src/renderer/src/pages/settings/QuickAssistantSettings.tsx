import { InfoCircleOutlined } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { DeleteIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setQuickAssistantModel } from '@renderer/store/llm'
import {
  setClickTrayToShowQuickAssistant,
  setEnableQuickAssistant,
  setQuickAssistantPrompt,
  setQuickAssistantReasoningEffort,
  setReadClipboardAtStartup
} from '@renderer/store/settings'
import type { Model, ThinkingOption } from '@renderer/types'
import { reasoningOptionsForModel } from '@renderer/utils/reasoningKernel'
import { Button, Select, Switch, Tooltip } from 'antd'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  SettingContainer,
  SettingDescription,
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle
} from '.'

/** 思考档位 → i18n key（与输入栏 ThinkingButton 共用词表）。 */
const REASONING_LABEL_KEY: Record<ThinkingOption, string> = {
  default: 'assistants.settings.reasoning_effort.default',
  none: 'assistants.settings.reasoning_effort.off',
  minimal: 'assistants.settings.reasoning_effort.minimal',
  low: 'assistants.settings.reasoning_effort.low',
  medium: 'assistants.settings.reasoning_effort.medium',
  high: 'assistants.settings.reasoning_effort.high',
  xhigh: 'assistants.settings.reasoning_effort.xhigh',
  max: 'assistants.settings.reasoning_effort.xhigh',
  auto: 'assistants.settings.reasoning_effort.auto'
}

/** 思考档位描述 → i18n key。 */
const REASONING_DESC_KEY: Record<ThinkingOption, string> = {
  default: 'assistants.settings.reasoning_effort.default_description',
  none: 'assistants.settings.reasoning_effort.off_description',
  minimal: 'assistants.settings.reasoning_effort.minimal_description',
  low: 'assistants.settings.reasoning_effort.low_description',
  medium: 'assistants.settings.reasoning_effort.medium_description',
  high: 'assistants.settings.reasoning_effort.high_description',
  xhigh: 'assistants.settings.reasoning_effort.xhigh_description',
  max: 'assistants.settings.reasoning_effort.xhigh_description',
  auto: 'assistants.settings.reasoning_effort.auto_description'
}

/**
 * 快捷助手设置：独立的模型与提示词（不依赖 Assistant 对象）。
 * 快捷助手消息不计入聊天消息库，交互为独立简单 chatbot。
 */
const QuickAssistantSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const {
    enableQuickAssistant,
    clickTrayToShowQuickAssistant,
    quickAssistantPrompt,
    quickAssistantReasoningEffort,
    setTray,
    readClipboardAtStartup
  } = useSettings()
  const dispatch = useAppDispatch()
  const { quickAssistantModel } = useAppSelector((state) => state.llm)
  // 与"默认模型设置"（AssistantModelSettings）同款：弹窗选模型；排除嵌入/重排/绘图
  const modelFilter = useCallback(
    (model: Model) => !isEmbeddingModel(model) && !isRerankModel(model) && !isTextToImageModel(model),
    []
  )

  const onSelectModel = useCallback(async () => {
    const selected = await SelectChatModelPopup.show({ model: quickAssistantModel ?? undefined, filter: modelFilter })
    if (selected) {
      dispatch(setQuickAssistantModel({ model: selected }))
      // 换模型后把档位收敛到新模型支持的选项（与原版自动纠正行为一致）
      const options = reasoningOptionsForModel(selected)
      if (!options.includes(quickAssistantReasoningEffort ?? 'none')) {
        dispatch(setQuickAssistantReasoningEffort(options[0] ?? 'none'))
      }
    }
  }, [dispatch, modelFilter, quickAssistantModel, quickAssistantReasoningEffort])

  const onClearModel = useCallback(() => {
    dispatch(setQuickAssistantModel({ model: undefined }))
  }, [dispatch])

  const handleEnableQuickAssistant = async (enable: boolean) => {
    dispatch(setEnableQuickAssistant(enable))
    await window.api.config.set('enableQuickAssistant', enable, true)

    void (!enable && window.api.miniWindow.close())

    if (enable && !clickTrayToShowQuickAssistant) {
      window.toast.info({
        title: t('settings.quickAssistant.use_shortcut_to_show'),
        timeout: 4000,
        icon: <InfoCircleOutlined />
      })
    }

    if (enable && clickTrayToShowQuickAssistant) {
      setTray(true)
    }
  }

  const handleClickTrayToShowQuickAssistant = async (checked: boolean) => {
    dispatch(setClickTrayToShowQuickAssistant(checked))
    await window.api.config.set('clickTrayToShowQuickAssistant', checked)
    checked && setTray(true)
  }

  const handleClickReadClipboardAtStartup = async (checked: boolean) => {
    dispatch(setReadClipboardAtStartup(checked))
    await window.api.config.set('readClipboardAtStartup', checked)
    void window.api.miniWindow.close()
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.quickAssistant.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{t('settings.quickAssistant.enable_quick_assistant')}</span>
            <Tooltip title={t('settings.quickAssistant.use_shortcut_to_show')} placement="right">
              <InfoCircleOutlined style={{ cursor: 'pointer' }} />
            </Tooltip>
          </SettingRowTitle>
          <Switch checked={enableQuickAssistant} onChange={handleEnableQuickAssistant} />
        </SettingRow>
        {enableQuickAssistant && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.quickAssistant.click_tray_to_show')}</SettingRowTitle>
              <Switch checked={clickTrayToShowQuickAssistant} onChange={handleClickTrayToShowQuickAssistant} />
            </SettingRow>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.quickAssistant.read_clipboard_at_startup')}</SettingRowTitle>
              <Switch checked={readClipboardAtStartup} onChange={handleClickReadClipboardAtStartup} />
            </SettingRow>
          </>
        )}
      </SettingGroup>
      {enableQuickAssistant && (
        <SettingGroup theme={theme}>
          <SettingTitle>{t('settings.quickAssistant.model_label')}</SettingTitle>
          <SettingDivider />
          <SettingRow>
            <HStack style={{ width: '100%' }} justifyContent="flex-end">
              <HStack alignItems="center" gap={5}>
                <ModelSelectButton
                  icon={
                    quickAssistantModel ? <ModelAvatar model={quickAssistantModel} size={20} /> : <PlusIcon size={18} />
                  }
                  onClick={onSelectModel}>
                  <ModelName>
                    {quickAssistantModel ? quickAssistantModel.name : t('assistants.presets.edit.model.select.title')}
                  </ModelName>
                </ModelSelectButton>
                {quickAssistantModel && (
                  <Button
                    color="danger"
                    variant="filled"
                    icon={<DeleteIcon size={14} className="lucide-custom" />}
                    onClick={onClearModel}
                    danger
                  />
                )}
              </HStack>
            </HStack>
          </SettingRow>
          <SettingDescription>{t('settings.quickAssistant.model_description')}</SettingDescription>
        </SettingGroup>
      )}
      {enableQuickAssistant && quickAssistantModel && reasoningOptionsForModel(quickAssistantModel).length > 0 && (
        <SettingGroup theme={theme}>
          <SettingTitle>{t('assistants.settings.reasoning_effort.label')}</SettingTitle>
          <SettingDivider />
          <SettingRow>
            <HStack style={{ width: '100%' }}>
              <Select
                style={{ width: 360 }}
                value={quickAssistantReasoningEffort ?? 'none'}
                options={reasoningOptionsForModel(quickAssistantModel).map((option) => ({
                  value: option,
                  label: t(REASONING_LABEL_KEY[option])
                }))}
                onChange={(option: ThinkingOption) => dispatch(setQuickAssistantReasoningEffort(option))}
              />
            </HStack>
          </SettingRow>
          <SettingDescription>{t(REASONING_DESC_KEY[quickAssistantReasoningEffort ?? 'none'])}</SettingDescription>
        </SettingGroup>
      )}
      {enableQuickAssistant && (
        <SettingGroup theme={theme}>
          <SettingTitle>{t('settings.quickAssistant.prompt_label')}</SettingTitle>
          <SettingDivider />
          <SettingRow>
            <PromptTextarea
              value={quickAssistantPrompt}
              onChange={(value) => dispatch(setQuickAssistantPrompt(value))}
              placeholder={t('settings.quickAssistant.prompt_placeholder')}
            />
          </SettingRow>
          <SettingDescription>{t('settings.quickAssistant.prompt_description')}</SettingDescription>
        </SettingGroup>
      )}
    </SettingContainer>
  )
}

/**
 * 提示词输入框：原生 textarea + 本地受控 + 防抖提交。
 * 避免 antd TextArea 每键 dispatch 到全局 store 造成的重渲染/焦点怪癖。
 */
function PromptTextarea({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  // 防抖 300ms 提交，避免每键同步 dispatch 触发全页重渲染
  useEffect(() => {
    if (draft === value) return
    const timer = window.setTimeout(() => onChange(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, onChange, value])

  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={placeholder}
      rows={4}
      spellCheck={false}
      className="ant-input"
      style={{
        width: '100%',
        minHeight: 88,
        resize: 'vertical',
        padding: '4px 11px',
        fontSize: 14,
        lineHeight: 1.5715,
        color: 'var(--color-text-1)',
        backgroundColor: 'var(--color-background-soft)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        outline: 'none',
        fontFamily: 'inherit'
      }}
    />
  )
}

/**
 * 与"默认模型设置"（AssistantModelSettings）同款的选择按钮样式，保持风格统一。
 */
const ModelSelectButton = styled(Button)`
  max-width: 300px;
  justify-content: flex-start;

  .ant-btn-icon {
    flex-shrink: 0;
  }
`

const ModelName = styled.span`
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
`

export default QuickAssistantSettings
