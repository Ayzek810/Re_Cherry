import { InfoCircleOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useProviders } from '@renderer/hooks/useProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { getModelUniqId } from '@renderer/services/ModelService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setQuickAssistantModel } from '@renderer/store/llm'
import {
  setClickTrayToShowQuickAssistant,
  setEnableQuickAssistant,
  setQuickAssistantPrompt,
  setReadClipboardAtStartup
} from '@renderer/store/settings'
import { Select, Switch, Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SettingContainer,
  SettingDescription,
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle
} from '.'

/**
 * 快捷助手设置：独立的模型与提示词（不依赖 Assistant 对象）。
 * 快捷助手消息不计入聊天消息库，交互为独立简单 chatbot。
 */
const QuickAssistantSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { enableQuickAssistant, clickTrayToShowQuickAssistant, quickAssistantPrompt, setTray, readClipboardAtStartup } =
    useSettings()
  const dispatch = useAppDispatch()
  const { quickAssistantModel } = useAppSelector((state) => state.llm)
  const { providers } = useProviders()

  // 可用模型列表（排除嵌入/重排/绘图模型）
  const modelOptions = useMemo(() => {
    return providers.flatMap((provider) =>
      provider.models
        .filter((model) => !isEmbeddingModel(model) && !isRerankModel(model) && !isTextToImageModel(model))
        .map((model) => ({
          value: getModelUniqId(model),
          label: `${model.name} | ${provider.name}`
        }))
    )
  }, [providers])

  const quickAssistantModelValue = useMemo(
    () => (quickAssistantModel ? getModelUniqId(quickAssistantModel) : undefined),
    [quickAssistantModel]
  )

  const handleModelChange = useCallback(
    (value: string) => {
      let query: { id?: string; provider?: string } | undefined
      try {
        query = JSON.parse(value) as { id?: string; provider?: string }
      } catch {
        query = undefined
      }
      const model = providers
        .flatMap((provider) => provider.models)
        .find((m) => m.id === query?.id && m.provider === query?.provider)
      if (model) dispatch(setQuickAssistantModel({ model }))
    },
    [dispatch, providers]
  )

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
            <HStack style={{ width: '100%' }}>
              <Select
                value={quickAssistantModelValue}
                style={{ width: 360 }}
                showSearch
                optionFilterProp="label"
                options={modelOptions}
                onChange={handleModelChange}
                placeholder={t('settings.models.empty')}
              />
            </HStack>
          </SettingRow>
          <SettingDescription>{t('settings.quickAssistant.model_description')}</SettingDescription>
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

export default QuickAssistantSettings
