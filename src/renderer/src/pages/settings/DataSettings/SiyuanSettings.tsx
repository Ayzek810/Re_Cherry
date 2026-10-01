import { InfoCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import { setSiyuanApiUrl, setSiyuanBoxId, setSiyuanRootPath, setSiyuanToken } from '@renderer/store/settings'
import { Button, Space, Tooltip } from 'antd'
import { Input } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'
import { useCommittedInput } from './useCommittedInput'

const logger = loggerService.withContext('SiyuanSettings')

const SiyuanSettings: FC = () => {
  const { openSmartMinapp } = useMinappPopup()
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()

  const siyuanApiUrl = useSelector((state: RootState) => state.settings.siyuanApiUrl)
  const siyuanToken = useSelector((state: RootState) => state.settings.siyuanToken)
  const siyuanBoxId = useSelector((state: RootState) => state.settings.siyuanBoxId)
  const siyuanRootPath = useSelector((state: RootState) => state.settings.siyuanRootPath)

  // s2-14：打字只改本地草稿，失焦才写 redux-persist 切片。
  const apiUrlField = useCommittedInput(siyuanApiUrl, (next) => dispatch(setSiyuanApiUrl(next)))
  const tokenField = useCommittedInput(siyuanToken, (next) => dispatch(setSiyuanToken(next)))
  const boxIdField = useCommittedInput(siyuanBoxId, (next) => dispatch(setSiyuanBoxId(next)))
  const rootPathField = useCommittedInput(siyuanRootPath, (next) => dispatch(setSiyuanRootPath(next)))

  const handleSiyuanHelpClick = () => {
    openSmartMinapp({
      id: 'siyuan-help',
      // s2-41：`name` 是用户可见的弹窗标题（MinappPopupContainer 直接渲染它）。
      name: t('settings.data.siyuan.title'),
      url: 'https://docs.cherry-ai.com/advanced-basic/siyuan',
      logo: AppLogo
    })
  }

  const handleCheckConnection = async () => {
    try {
      if (!siyuanApiUrl || !siyuanToken) {
        window.toast.error(t('settings.data.siyuan.check.empty_config'))
        return
      }

      const response = await fetch(`${siyuanApiUrl}/api/notebook/lsNotebooks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${siyuanToken}`
        }
      })

      if (!response.ok) {
        window.toast.error(t('settings.data.siyuan.check.fail'))
        return
      }

      const data = await response.json()
      if (data.code !== 0) {
        window.toast.error(t('settings.data.siyuan.check.fail'))
        return
      }

      window.toast.success(t('settings.data.siyuan.check.success'))
    } catch (error) {
      logger.error('Check Siyuan connection failed:', error as Error)
      window.toast.error(t('settings.data.siyuan.check.error'))
    }
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.siyuan.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.siyuan.api_url')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={apiUrlField.value}
            onChange={apiUrlField.onChange}
            onBlur={apiUrlField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.siyuan.api_url_placeholder')}
          />
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle style={{ display: 'flex', alignItems: 'center' }}>
          <span>{t('settings.data.siyuan.token.label')}</span>
          <Tooltip title={t('settings.data.siyuan.token.help')} placement="left">
            <InfoCircleOutlined
              style={{ color: 'var(--color-text-2)', cursor: 'pointer', marginLeft: 4 }}
              onClick={handleSiyuanHelpClick}
            />
          </Tooltip>
        </SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={tokenField.value}
              onChange={tokenField.onChange}
              onBlur={tokenField.onBlur}
              placeholder={t('settings.data.siyuan.token_placeholder')}
              style={{ width: '100%' }}
            />
            <Button onClick={handleCheckConnection}>{t('settings.data.siyuan.check.button')}</Button>
          </Space.Compact>
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.siyuan.box_id')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={boxIdField.value}
            onChange={boxIdField.onChange}
            onBlur={boxIdField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.siyuan.box_id_placeholder')}
          />
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.siyuan.root_path')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={rootPathField.value}
            onChange={rootPathField.onChange}
            onBlur={rootPathField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.siyuan.root_path_placeholder')}
          />
        </HStack>
      </SettingRow>
    </SettingGroup>
  )
}

export default SiyuanSettings
