import { InfoCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import { setYuqueRepoId, setYuqueToken, setYuqueUrl } from '@renderer/store/settings'
import { Button, Space, Tooltip } from 'antd'
import { Input } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'
import { useCommittedInput } from './useCommittedInput'

const logger = loggerService.withContext('YuqueSettings')

const YuqueSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const { openSmartMinapp } = useMinappPopup()

  const yuqueToken = useSelector((state: RootState) => state.settings.yuqueToken)
  const yuqueUrl = useSelector((state: RootState) => state.settings.yuqueUrl)

  // 打字只改本地草稿，失焦才写 redux-persist 切片。
  const tokenField = useCommittedInput(yuqueToken, (next) => dispatch(setYuqueToken(next)))
  const repoUrlField = useCommittedInput(yuqueUrl, (next) => dispatch(setYuqueUrl(next)))

  const handleYuqueConnectionCheck = async () => {
    if (!yuqueToken) {
      window.toast.error(t('settings.data.yuque.check.empty_token'))
      return
    }
    if (!yuqueUrl) {
      window.toast.error(t('settings.data.yuque.check.empty_repo_url'))
      return
    }

    // 这里此前完全没有错误路径——离线 / DNS 失败时 fetch 直接拒绝，
    // 未处理的 rejection + 按钮毫无反馈；响应体缺 `data` 时读 `data.data.id` 抛 TypeError。
    // 对照同目录 SiyuanSettings 的样板（try/catch + 三种 toast）。
    try {
      const response = await fetch('https://www.yuque.com/api/v2/hello', {
        headers: {
          'X-Auth-Token': yuqueToken
        }
      })

      if (!response.ok) {
        window.toast.error(t('settings.data.yuque.check.fail'))
        return
      }
      const yuqueSlug = yuqueUrl.replace('https://www.yuque.com/', '')
      const repoIDResponse = await fetch(`https://www.yuque.com/api/v2/repos/${yuqueSlug}`, {
        headers: {
          'X-Auth-Token': yuqueToken
        }
      })
      if (!repoIDResponse.ok) {
        window.toast.error(t('settings.data.yuque.check.fail'))
        return
      }
      const data = await repoIDResponse.json()
      const repoId = data?.data?.id
      if (repoId === undefined || repoId === null) {
        logger.warn('Yuque repo id missing in response', { slug: yuqueSlug })
        window.toast.error(t('settings.data.yuque.check.fail'))
        return
      }
      dispatch(setYuqueRepoId(repoId))
      window.toast.success(t('settings.data.yuque.check.success'))
    } catch (error) {
      logger.error('Check Yuque connection failed:', error as Error)
      window.toast.error(t('settings.data.yuque.check.error', { defaultValue: 'Connection error' }))
    }
  }

  const handleYuqueHelpClick = () => {
    openSmartMinapp({
      id: 'yuque-help',
      // `name` 是用户可见的弹窗标题（MinappPopupContainer 直接渲染它），
      // 此前硬编码英文，zh-CN 下与周围全部本地化的字符串不一致。
      name: t('settings.data.yuque.title'),
      url: 'https://www.yuque.com/settings/tokens',
      logo: AppLogo
    })
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.yuque.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.yuque.repo_url')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={repoUrlField.value}
            onChange={repoUrlField.onChange}
            onBlur={repoUrlField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.yuque.repo_url_placeholder')}
          />
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>
          {t('settings.data.yuque.token')}
          <Tooltip title={t('settings.data.yuque.help')} placement="left">
            <InfoCircleOutlined
              style={{ color: 'var(--color-text-2)', cursor: 'pointer', marginLeft: 4 }}
              onClick={handleYuqueHelpClick}
            />
          </Tooltip>
        </SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={tokenField.value}
              onChange={tokenField.onChange}
              onBlur={tokenField.onBlur}
              placeholder={t('settings.data.yuque.token_placeholder')}
              style={{ width: '100%' }}
            />
            <Button onClick={handleYuqueConnectionCheck}>{t('settings.data.yuque.check.button')}</Button>
          </Space.Compact>
        </HStack>
      </SettingRow>
    </SettingGroup>
  )
}

export default YuqueSettings
