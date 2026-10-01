import { InfoCircleOutlined } from '@ant-design/icons'
import { Client } from '@notionhq/client'
import { HStack } from '@renderer/components/Layout'
import { AppLogo } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import {
  setNotionApiKey,
  setNotionDatabaseID,
  setNotionExportReasoning,
  setNotionPageNameKey
} from '@renderer/store/settings'
import { Button, Space, Switch, Tooltip } from 'antd'
import { Input } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'
import { useCommittedInput } from './useCommittedInput'
const NotionSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const { openSmartMinapp } = useMinappPopup()

  const notionApiKey = useSelector((state: RootState) => state.settings.notionApiKey)
  const notionDatabaseID = useSelector((state: RootState) => state.settings.notionDatabaseID)
  const notionPageNameKey = useSelector((state: RootState) => state.settings.notionPageNameKey)
  const notionExportReasoning = useSelector((state: RootState) => state.settings.notionExportReasoning)

  // 打字只改本地草稿，失焦才写 redux-persist 切片。
  const tokenField = useCommittedInput(notionApiKey, (next) => dispatch(setNotionApiKey(next)))
  const databaseIdField = useCommittedInput(notionDatabaseID, (next) => dispatch(setNotionDatabaseID(next)))
  const pageNameKeyField = useCommittedInput(notionPageNameKey, (next) => dispatch(setNotionPageNameKey(next)))

  const handleNotionConnectionCheck = () => {
    // 守卫此前写成 `=== null`，而持久化默认值是空串（`store/settings.ts`
    // 的 `notionApiKey: ''` / `notionDatabaseID: ''`），所以永远不触发——空 key 会真的发出
    // `databases.retrieve`，用户最终看到的是无关的「连接失败」，而不是「请先填 API Key」。
    // Joplin / Siyuan 对同一校验用的是 falsy 判断，这里对齐。
    if (!notionApiKey) {
      window.toast.error(t('settings.data.notion.check.empty_api_key'))
      return
    }
    if (!notionDatabaseID) {
      window.toast.error(t('settings.data.notion.check.empty_database_id'))
      return
    }
    const notion = new Client({ auth: notionApiKey })
    notion.databases
      .retrieve({
        database_id: notionDatabaseID
      })
      .then((result) => {
        if (result) {
          window.toast.success(t('settings.data.notion.check.success'))
        } else {
          window.toast.error(t('settings.data.notion.check.fail'))
        }
      })
      .catch(() => {
        window.toast.error(t('settings.data.notion.check.error'))
      })
  }

  const handleNotionTitleClick = () => {
    openSmartMinapp({
      id: 'notion-help',
      // `name` 是用户可见的弹窗标题（MinappPopupContainer 直接渲染它）。
      name: t('settings.data.notion.title'),
      url: 'https://docs.cherry-ai.com/advanced-basic/notion',
      logo: AppLogo
    })
  }

  const handleNotionExportReasoningChange = (checked: boolean) => {
    dispatch(setNotionExportReasoning(checked))
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle style={{ justifyContent: 'flex-start', gap: 10 }}>
        {t('settings.data.notion.title')}
        <Tooltip title={t('settings.data.notion.help')} placement="right">
          <InfoCircleOutlined
            style={{ color: 'var(--color-text-2)', cursor: 'pointer' }}
            onClick={handleNotionTitleClick}
          />
        </Tooltip>
      </SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.notion.database_id')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={databaseIdField.value}
            onChange={databaseIdField.onChange}
            onBlur={databaseIdField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.notion.database_id_placeholder')}
          />
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.notion.page_name_key')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Input
            type="text"
            value={pageNameKeyField.value}
            onChange={pageNameKeyField.onChange}
            onBlur={pageNameKeyField.onBlur}
            style={{ width: 315 }}
            placeholder={t('settings.data.notion.page_name_key_placeholder')}
          />
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.notion.api_key')}</SettingRowTitle>
        <HStack alignItems="center" gap="5px" style={{ width: 315 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={tokenField.value}
              onChange={tokenField.onChange}
              onBlur={tokenField.onBlur}
              placeholder={t('settings.data.notion.api_key_placeholder')}
              style={{ width: '100%' }}
            />
            <Button onClick={handleNotionConnectionCheck}>{t('settings.data.notion.check.button')}</Button>
          </Space.Compact>
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.notion.export_reasoning.title')}</SettingRowTitle>
        <Switch checked={notionExportReasoning} onChange={handleNotionExportReasoningChange} />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.notion.export_reasoning.help')}</SettingHelpText>
      </SettingRow>
    </SettingGroup>
  )
}

export default NotionSettings
