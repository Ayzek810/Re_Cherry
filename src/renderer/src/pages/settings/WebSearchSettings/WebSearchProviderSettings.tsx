import { useTheme } from '@renderer/context/ThemeProvider'
import type { WebSearchProviderId } from '@renderer/types'
import { Alert } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

import { SettingContainer, SettingGroup } from '..'
import WebSearchProviderSetting from './WebSearchProviderSetting'

const WebSearchProviderSettings: FC = () => {
  const { providerId } = useParams<{ providerId: string }>()
  const { theme } = useTheme()
  const { t } = useTranslation()

  // 缺参时此前 `return null`（静默空白，「没有地址」被画成「什么都没有」）。
  if (!providerId) {
    return (
      <SettingContainer theme={theme}>
        <SettingGroup theme={theme}>
          <Alert
            type="warning"
            showIcon
            message={t('settings.tool.websearch.provider_missing', {
              defaultValue: 'This page needs a search provider id in the URL.'
            })}
          />
        </SettingGroup>
      </SettingContainer>
    )
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <WebSearchProviderSetting providerId={providerId as WebSearchProviderId} />
      </SettingGroup>
    </SettingContainer>
  )
}

export default WebSearchProviderSettings
