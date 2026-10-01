/** v0.3.2 自 CS_V1 移植（文档处理 provider 选择 + 表单；裁剪见目录 index 头注释）。 */
import { useTheme } from '@renderer/context/ThemeProvider'
import { useDefaultPreprocessProvider, usePreprocessProviders } from '@renderer/hooks/usePreprocess'
import { Select } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'
import PreprocessProviderSettings from './PreprocessProviderSettings'

const PreprocessSettings: FC = () => {
  const { preprocessProviders } = usePreprocessProviders()
  const { provider: defaultProvider, setDefaultPreprocessProvider } = useDefaultPreprocessProvider()
  const { t } = useTranslation()
  const { theme: themeMode } = useTheme()

  /**
   * v1 二轮审查 s2-11：选中值直接从 redux 派生，不再本地镜像一份。
   *
   * 旧实现在这里 `useState(defaultProvider)`，而默认 provider 也被知识库表单等其他消费者
   * 修改（`useDefaultPreprocessProvider` 只写 id），且没有任何 effect 回同步本页草稿——
   * 别处改掉默认 provider 后，本页 Select 仍显示旧值，用户看到的选择是假的。
   */
  function updateSelectedPreprocessProvider(providerId: string) {
    const provider = preprocessProviders.find((p) => p.id === providerId)
    if (!provider) {
      return
    }
    setDefaultPreprocessProvider(provider)
  }

  return (
    <>
      <SettingGroup theme={themeMode}>
        <SettingTitle>{t('settings.tool.preprocess.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.tool.preprocess.provider')}</SettingRowTitle>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Select
              value={defaultProvider?.id}
              style={{ width: '200px' }}
              onChange={(value: string) => updateSelectedPreprocessProvider(value)}
              placeholder={t('settings.tool.preprocess.provider_placeholder')}
              options={preprocessProviders.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
        </SettingRow>
      </SettingGroup>
      {defaultProvider && (
        <SettingGroup theme={themeMode}>
          <PreprocessProviderSettings provider={defaultProvider} />
        </SettingGroup>
      )}
    </>
  )
}

export default PreprocessSettings
