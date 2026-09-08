import { HStack } from '@renderer/components/Layout'
import ModelSelector from '@renderer/components/ModelSelector'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { isEmbeddingModel, isRerankModel, isTextToImageModel } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId, hasModel } from '@renderer/services/ModelService'
import type { Model } from '@renderer/types'
import { Button } from 'antd'
import { find } from 'lodash'
import { MessageSquareMore, Rocket, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingDescription, SettingGroup, SettingTitle } from '..'
import DefaultAssistantSettings from './DefaultAssistantSettings'
import TopicNamingModalPopup from './QuickModelPopup'

interface ModelSettingsProps {
  showSettingsButton?: boolean
  showDescription?: boolean
  compact?: boolean
}

const ModelSettings: FC<ModelSettingsProps> = ({
  showSettingsButton = true,
  showDescription = true,
  compact = false
}) => {
  const { defaultModel, quickModel, setDefaultModel, setQuickModel } = useDefaultModel()
  const { providers } = useProviders()
  const allModels = providers.map((p) => p.models).flat()
  const { theme } = useTheme()
  const { t } = useTranslation()

  const modelPredicate = useCallback(
    (m: Model) => !isEmbeddingModel(m) && !isRerankModel(m) && !isTextToImageModel(m),
    []
  )

  const defaultModelValue = useMemo(
    () => (hasModel(defaultModel) ? getModelUniqId(defaultModel) : undefined),
    [defaultModel]
  )

  const defaultQuickModel = useMemo(() => (hasModel(quickModel) ? getModelUniqId(quickModel) : undefined), [quickModel])

  const containerStyle = compact ? { padding: 0, background: 'transparent' } : undefined
  const groupStyle = compact ? { padding: 0, border: 'none', background: 'transparent' } : undefined

  return (
    <SettingContainer theme={theme} style={containerStyle}>
      <SettingGroup theme={theme} style={groupStyle}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <MessageSquareMore size={18} color="var(--color-text)" />
            {t('settings.models.default_assistant_model')}
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultModelValue}
            defaultValue={defaultModelValue}
            style={{ width: compact ? '100%' : 360 }}
            size={compact ? 'large' : 'middle'}
            onChange={(value) => setDefaultModel(find(allModels, JSON.parse(value)) as Model)}
            placeholder={t('settings.models.empty')}
          />
          {showSettingsButton && (
            <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={DefaultAssistantSettings.show} />
          )}
        </HStack>
        {showDescription && (
          <SettingDescription>{t('settings.models.default_assistant_model_description')}</SettingDescription>
        )}
      </SettingGroup>
      <SettingGroup theme={theme} style={groupStyle}>
        <SettingTitle style={{ marginBottom: 12 }}>
          <HStack alignItems="center" gap={10}>
            <Rocket size={18} color="var(--color-text)" />
            {t('settings.models.quick_model.label')}
            <InfoTooltip title={t('settings.models.quick_model.tooltip')} />
          </HStack>
        </SettingTitle>
        <HStack alignItems="center">
          <ModelSelector
            providers={providers}
            predicate={modelPredicate}
            value={defaultQuickModel}
            defaultValue={defaultQuickModel}
            style={{ width: compact ? '100%' : 360 }}
            size={compact ? 'large' : 'middle'}
            onChange={(value) => setQuickModel(find(allModels, JSON.parse(value)) as Model)}
            placeholder={t('settings.models.empty')}
          />
          {showSettingsButton && (
            <Button icon={<Settings2 size={16} />} style={{ marginLeft: 8 }} onClick={TopicNamingModalPopup.show} />
          )}
        </HStack>
        {showDescription && <SettingDescription>{t('settings.models.quick_model.description')}</SettingDescription>}
      </SettingGroup>
    </SettingContainer>
  )
}

export default ModelSettings
