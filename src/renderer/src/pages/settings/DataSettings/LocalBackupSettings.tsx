import { DeleteOutlined, FolderOpenOutlined, SaveOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { HStack } from '@renderer/components/Layout'
import { LocalBackupManager } from '@renderer/components/LocalBackupManager'
import { LocalBackupModal, useLocalBackupModal } from '@renderer/components/LocalBackupModals'
import Selector from '@renderer/components/Selector'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { startAutoSync, stopAutoSync } from '@renderer/services/BackupService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  setLocalBackupAutoSync,
  setLocalBackupDir as _setLocalBackupDir,
  setLocalBackupMaxBackups as _setLocalBackupMaxBackups,
  setLocalBackupSkipBackupFile as _setLocalBackupSkipBackupFile,
  setLocalBackupSyncInterval as _setLocalBackupSyncInterval
} from '@renderer/store/settings'
import type { AppInfo } from '@renderer/types'
import { Button, Input, Switch, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

const logger = loggerService.withContext('LocalBackupSettings')

const LocalBackupSettings: React.FC = () => {
  const dispatch = useAppDispatch()

  const {
    localBackupDir: localBackupDirSetting,
    localBackupSyncInterval: localBackupSyncIntervalSetting,
    localBackupMaxBackups: localBackupMaxBackupsSetting,
    localBackupSkipBackupFile: localBackupSkipBackupFileSetting
  } = useSettings()

  const [localBackupDir, setLocalBackupDir] = useState<string | undefined>(localBackupDirSetting)
  const [resolvedLocalBackupDir, setResolvedLocalBackupDir] = useState<string | undefined>(undefined)
  const [localBackupSkipBackupFile, setLocalBackupSkipBackupFile] = useState<boolean>(localBackupSkipBackupFileSetting)
  const [backupManagerVisible, setBackupManagerVisible] = useState(false)

  const [syncInterval, setSyncInterval] = useState<number>(localBackupSyncIntervalSetting)
  const [maxBackups, setMaxBackups] = useState<number>(localBackupMaxBackupsSetting)

  const [appInfo, setAppInfo] = useState<AppInfo>()

  const [appInfoFailed, setAppInfoFailed] = useState(false)

  useEffect(() => {
    // 此前无 catch。`appInfo!.appDataPath` 是个非空断言——「未知」在事件
    // 处理器里变成 TypeError，用户选的目录不落库且没有任何提示。
    void window.api
      .getAppInfo()
      .then(setAppInfo)
      .catch((error: unknown) => {
        logger.warn('Failed to read app info', error as Error)
        setAppInfoFailed(true)
      })
  }, [])

  useEffect(() => {
    if (localBackupDirSetting) {
      void window.api.resolvePath(localBackupDirSetting).then(setResolvedLocalBackupDir)
    }
  }, [localBackupDirSetting])

  const { theme } = useTheme()

  const { t } = useTranslation()

  const { localBackupSync } = useAppSelector((state) => state.backup)

  const onSyncIntervalChange = (value: number) => {
    setSyncInterval(value)
    dispatch(_setLocalBackupSyncInterval(value))
    if (value === 0) {
      dispatch(setLocalBackupAutoSync(false))
      stopAutoSync('local')
    } else {
      dispatch(setLocalBackupAutoSync(true))
      startAutoSync(false, 'local')
    }
  }

  const checkLocalBackupDirValid = async (dir: string) => {
    if (dir === '') {
      return false
    }

    // 应用信息读不到时不能拿 `!` 断言去取值（TypeError），
    // 也不该静默失败——如实拒绝并说明原因。
    if (!appInfo) {
      logger.warn('Cannot validate backup directory: application paths are unavailable')
      window.toast.error(
        t('settings.data.local.directory.app_info_unavailable', {
          defaultValue: 'Cannot check the directory: application paths are unavailable. Retry later.'
        })
      )
      return false
    }

    const resolvedDir = await window.api.resolvePath(dir)

    // check new local backup dir is not in app data path
    // if is in app data path, show error
    if (await window.api.isPathInside(resolvedDir, appInfo.appDataPath)) {
      window.toast.error(t('settings.data.local.directory.select_error_app_data_path'))
      return false
    }

    // check new local backup dir is not in app install path
    // if is in app install path, show error
    if (await window.api.isPathInside(resolvedDir, appInfo.installPath)) {
      window.toast.error(t('settings.data.local.directory.select_error_in_app_install_path'))
      return false
    }

    // check new app data path has write permission
    const hasWritePermission = await window.api.hasWritePermission(resolvedDir)
    if (!hasWritePermission) {
      window.toast.error(t('settings.data.local.directory.select_error_write_permission'))
      return false
    }

    return true
  }

  const handleLocalBackupDirChange = async (value: string) => {
    if (value === localBackupDirSetting) {
      return
    }

    if (value === '') {
      handleClearDirectory()
      return
    }

    if (await checkLocalBackupDirValid(value)) {
      setLocalBackupDir(value)
      dispatch(_setLocalBackupDir(value))
      setResolvedLocalBackupDir(await window.api.resolvePath(value))

      dispatch(setLocalBackupAutoSync(true))
      startAutoSync(true, 'local')
      return
    }

    if (localBackupDirSetting) {
      setLocalBackupDir(localBackupDirSetting)
      return
    }
  }

  const onMaxBackupsChange = (value: number) => {
    setMaxBackups(value)
    dispatch(_setLocalBackupMaxBackups(value))
  }

  const onSkipBackupFilesChange = (value: boolean) => {
    setLocalBackupSkipBackupFile(value)
    dispatch(_setLocalBackupSkipBackupFile(value))
  }

  const handleBrowseDirectory = async () => {
    try {
      const newLocalBackupDir = await window.api.select({
        properties: ['openDirectory', 'createDirectory'],
        title: t('settings.data.local.directory.select_title')
      })

      if (!newLocalBackupDir) {
        return
      }

      await handleLocalBackupDirChange(newLocalBackupDir)
    } catch (error) {
      logger.error('Failed to select directory:', error as Error)
    }
  }

  const handleClearDirectory = () => {
    // 「清空」会同时丢掉输入框里未提交的草稿（`localBackupDir`）、
    // 清掉已保存的路径并把自动同步关掉——此前没有任何确认（同文件对更轻的复制数据操作
    // 反而有确认）。清空动作不可撤销，这里先问一次。
    window.modal.confirm({
      title: t('settings.data.local.directory.clear_confirm_title', { defaultValue: 'Clear backup directory?' }),
      content: t('settings.data.local.directory.clear_confirm_content', {
        defaultValue: 'The saved directory is cleared and auto backup is turned off. Unsaved edits are discarded.'
      }),
      okText: t('common.clear'),
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => {
        setLocalBackupDir('')
        dispatch(_setLocalBackupDir(''))
        dispatch(setLocalBackupAutoSync(false))
        stopAutoSync('local')
      }
    })
  }

  const renderSyncStatus = () => {
    if (!localBackupDir) return null

    if (!localBackupSync.lastSyncTime && !localBackupSync.syncing && !localBackupSync.lastSyncError) {
      return <span style={{ color: 'var(--text-secondary)' }}>{t('settings.data.local.noSync')}</span>
    }

    return (
      <HStack gap="5px" alignItems="center">
        {localBackupSync.syncing && <SyncOutlined spin />}
        {!localBackupSync.syncing && localBackupSync.lastSyncError && (
          <Tooltip title={`${t('settings.data.local.syncError')}: ${localBackupSync.lastSyncError}`}>
            <WarningOutlined style={{ color: 'red' }} />
          </Tooltip>
        )}
        {localBackupSync.lastSyncTime && (
          <span style={{ color: 'var(--text-secondary)' }}>
            {t('settings.data.local.lastSync')}: {dayjs(localBackupSync.lastSyncTime).format('HH:mm:ss')}
          </span>
        )}
      </HStack>
    )
  }

  const { isModalVisible, handleBackup, handleCancel, backuping, customFileName, setCustomFileName, showBackupModal } =
    useLocalBackupModal(resolvedLocalBackupDir)

  const showBackupManager = () => {
    setBackupManagerVisible(true)
  }

  const closeBackupManager = () => {
    setBackupManagerVisible(false)
  }

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.data.local.title')}</SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.local.directory.label')}</SettingRowTitle>
        <HStack gap="5px">
          <Input
            value={localBackupDir}
            onChange={(e) => setLocalBackupDir(e.target.value)}
            onBlur={(e) => handleLocalBackupDirChange(e.target.value)}
            placeholder={t('settings.data.local.directory.placeholder')}
            style={{ minWidth: 200, maxWidth: 400, flex: 1 }}
          />
          <Button icon={<FolderOpenOutlined />} onClick={handleBrowseDirectory}>
            {t('common.browse')}
          </Button>
          <Button icon={<DeleteOutlined />} onClick={handleClearDirectory} disabled={!localBackupDir} danger>
            {t('common.clear')}
          </Button>
        </HStack>
      </SettingRow>
      {appInfoFailed && (
        <SettingRow>
          <SettingHelpText>
            {t('settings.data.local.directory.app_info_unavailable', {
              defaultValue: 'Cannot check the directory: application paths are unavailable. Retry later.'
            })}
          </SettingHelpText>
        </SettingRow>
      )}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.general.backup.title')}</SettingRowTitle>
        <HStack gap="5px" justifyContent="space-between">
          <Button onClick={showBackupModal} icon={<SaveOutlined />} loading={backuping} disabled={!localBackupDir}>
            {t('settings.data.local.backup.button')}
          </Button>
          <Button onClick={showBackupManager} icon={<FolderOpenOutlined />} disabled={!localBackupDir}>
            {t('settings.data.local.restore.button')}
          </Button>
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.local.autoSync.label')}</SettingRowTitle>
        <Selector
          size={14}
          value={syncInterval}
          onChange={onSyncIntervalChange}
          disabled={!localBackupDir}
          options={[
            { label: t('settings.data.local.autoSync.off'), value: 0 },
            { label: t('settings.data.local.minute_interval', { count: 1 }), value: 1 },
            { label: t('settings.data.local.minute_interval', { count: 5 }), value: 5 },
            { label: t('settings.data.local.minute_interval', { count: 15 }), value: 15 },
            { label: t('settings.data.local.minute_interval', { count: 30 }), value: 30 },
            { label: t('settings.data.local.hour_interval', { count: 1 }), value: 60 },
            { label: t('settings.data.local.hour_interval', { count: 2 }), value: 120 },
            { label: t('settings.data.local.hour_interval', { count: 6 }), value: 360 },
            { label: t('settings.data.local.hour_interval', { count: 12 }), value: 720 },
            { label: t('settings.data.local.hour_interval', { count: 24 }), value: 1440 }
          ]}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.local.maxBackups.label')}</SettingRowTitle>
        <Selector
          size={14}
          value={maxBackups}
          onChange={onMaxBackupsChange}
          disabled={!localBackupDir}
          options={[
            { label: t('settings.data.local.maxBackups.unlimited'), value: 0 },
            { label: '1', value: 1 },
            { label: '3', value: 3 },
            { label: '5', value: 5 },
            { label: '10', value: 10 },
            { label: '20', value: 20 },
            { label: '50', value: 50 }
          ]}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.backup.skip_file_data_title')}</SettingRowTitle>
        <Switch checked={localBackupSkipBackupFile} onChange={onSkipBackupFilesChange} />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{t('settings.data.backup.skip_file_data_help')}</SettingHelpText>
      </SettingRow>
      {localBackupSync && syncInterval > 0 && (
        <>
          <SettingDivider />
          <SettingRow>
            <SettingRowTitle>{t('settings.data.local.syncStatus')}</SettingRowTitle>
            {renderSyncStatus()}
          </SettingRow>
        </>
      )}
      <>
        <LocalBackupModal
          isModalVisible={isModalVisible}
          handleBackup={handleBackup}
          handleCancel={handleCancel}
          backuping={backuping}
          customFileName={customFileName}
          setCustomFileName={setCustomFileName}
        />

        <LocalBackupManager
          visible={backupManagerVisible}
          onClose={closeBackupManager}
          localBackupDir={resolvedLocalBackupDir}
        />
      </>
    </SettingGroup>
  )
}

export default LocalBackupSettings
