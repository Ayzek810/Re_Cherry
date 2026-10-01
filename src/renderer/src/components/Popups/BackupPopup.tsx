import { loggerService } from '@logger'
import { getBackupProgressLabel } from '@renderer/i18n/label'
import { backup } from '@renderer/services/BackupService'
import store from '@renderer/store'
import { IpcChannel } from '@shared/IpcChannel'
import { Modal, Progress } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../TopView'

const logger = loggerService.withContext('BackupPopup')

interface Props {
  resolve: (data: any) => void
}

type ProgressStageType = 'preparing' | 'copying_database' | 'copying_files' | 'compressing' | 'completed'

interface ProgressData {
  stage: ProgressStageType
  progress: number
  total: number
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const [progressData, setProgressData] = useState<ProgressData>()
  const [isRunning, setIsRunning] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const { t } = useTranslation()
  const skipBackupFile = store.getState().settings.skipBackupFile

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(IpcChannel.BackupProgress, (_, data: ProgressData) => {
      setProgressData(data)
    })

    return () => {
      removeListener()
    }
  }, [])

  const onOk = async () => {
    logger.debug(`skipBackupFile: ${skipBackupFile}`)

    // 失败必须可见：进度停在未完成阶段时不能再把两个按钮一起禁掉，
    // 否则用户面对一个什么都点不动、也没有任何提示的模态框。
    setFailed(null)
    setIsRunning(true)
    try {
      await backup(skipBackupFile)
      setOpen(false)
    } catch (error) {
      logger.error('Backup failed:', error as Error)
      setProgressData(undefined)
      setFailed((error as Error)?.message || t('common.save_failed'))
      window.toast?.error(t('common.save_failed', 'Backup failed'))
    } finally {
      setIsRunning(false)
    }
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  const getProgressText = () => {
    if (!progressData) return ''

    if (progressData.stage === 'copying_files') {
      return t('backup.progress.copying_files', {
        progress: Math.floor(progressData.progress)
      })
    }
    return getBackupProgressLabel(progressData.stage)
  }

  BackupPopup.hide = onCancel

  // 只由「正在跑」驱动禁用，成功与失败都必须复位（失败后按钮必须能点）。
  const isRunningLock = isRunning
  const title = t('backup.title')
  const okText = t('backup.confirm.button')
  const content = t('backup.content')

  return (
    <Modal
      title={title}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      okButtonProps={{ disabled: isRunningLock }}
      cancelButtonProps={{ disabled: isRunningLock }}
      okText={okText}
      maskClosable={false}
      transitionName="animation-move-down"
      centered>
      {!progressData && !failed && <div>{content}</div>}
      {failed && <div data-testid="backup-error">{failed}</div>}
      {progressData && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Progress percent={Math.floor(progressData.progress)} strokeColor="var(--color-primary)" />
          <div style={{ marginTop: 16 }}>{getProgressText()}</div>
        </div>
      )}
    </Modal>
  )
}

const TopViewKey = 'BackupPopup'

// 导出给行为测试直接挂载；默认导出仍是 TopView 入口。
export { PopupContainer as BackupPopupContainer }

export default class BackupPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
