import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import { setDefaultObsidianVault } from '@renderer/store/settings'
import { Empty, Select, Spin } from 'antd'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'

const logger = loggerService.withContext('ObsidianSettings')

const { Option } = Select

const ObsidianSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const defaultObsidianVault = useSelector((state: RootState) => state.settings.defaultObsidianVault)

  const [vaults, setVaults] = useState<Array<{ path: string; name: string }>>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  // 组件加载时获取Vault列表
  useEffect(() => {
    const fetchVaults = async () => {
      try {
        setLoading(true)
        setError(null)
        const vaultsData = await window.api.obsidian.getVaults()

        if (vaultsData.length === 0) {
          setError(t('settings.data.obsidian.default_vault_no_vaults'))
          setLoading(false)
          return
        }

        setVaults(vaultsData)

        // 如果没有设置默认vault，则选择第一个
        if (!defaultObsidianVault && vaultsData.length > 0) {
          dispatch(setDefaultObsidianVault(vaultsData[0].name))
        }
      } catch (error) {
        logger.error('Failed to fetch Obsidian vaults:', error as Error)
        setError(t('settings.data.obsidian.default_vault_fetch_error'))
      } finally {
        setLoading(false)
      }
    }

    void fetchVaults()
  }, [dispatch, defaultObsidianVault, t])

  const handleChange = (value: string) => {
    dispatch(setDefaultObsidianVault(value))
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.obsidian.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.obsidian.default_vault')}</SettingRowTitle>
        <HStack gap="5px">
          <Spin spinning={loading} size="small">
            {vaults.length > 0 ? (
              <Select
                value={defaultObsidianVault || undefined}
                onChange={handleChange}
                placeholder={t('settings.data.obsidian.default_vault_placeholder')}
                style={{ width: 300 }}>
                {vaults.map((vault) => (
                  <Option key={vault.name} value={vault.name}>
                    {vault.name}
                  </Option>
                ))}
              </Select>
            ) : (
              <Empty
                description={
                  loading
                    ? t('settings.data.obsidian.default_vault_loading')
                    : error || t('settings.data.obsidian.default_vault_no_vaults')
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            )}
          </Spin>
        </HStack>
      </SettingRow>
    </SettingGroup>
  )
}

export default ObsidianSettings
