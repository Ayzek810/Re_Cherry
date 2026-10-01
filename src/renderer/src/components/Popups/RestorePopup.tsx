import { loggerService } from '@logger'
import { getRestoreProgressLabel } from '@renderer/i18n/label'
import { restore } from '@renderer/services/BackupService'
import { Modal, Progress } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../TopView'

const logger = loggerService.withContext('RestorePopup')

interface Props {
  resolve: (data: any) => void
}

interface ProgressData {
  stage: string
  progress: number
  total: number
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const [progressData, setProgressData] = useState<ProgressData>()
  const [isRunning, setIsRunning] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    const removeListener = window.api.events.onRestoreProgress((data) => {
      setProgressData(data as ProgressData)
    })

    return () => {
      removeListener()
    }
  }, [])

  const onOk = async () => {
    // 与 BackupPopup 同型：失败要可见、可关闭，不能把两个按钮一起禁死。
    setFailed(null)
    setIsRunning(true)
    try {
      await restore()
      setOpen(false)
    } catch (error) {
      logger.error('Restore failed:', error as Error)
      setProgressData(undefined)
      setFailed((error as Error)?.message || t('common.save_failed'))
      window.toast?.error(t('common.save_failed', 'Restore failed'))
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
      return t('restore.progress.copying_files', {
        progress: Math.floor(progressData.progress)
      })
    }
    return getRestoreProgressLabel(progressData.stage)
  }

  RestorePopup.hide = onCancel

  const isRunningLock = isRunning

  return (
    <Modal
      title={t('restore.title')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      okText={t('restore.confirm.button')}
      okButtonProps={{ disabled: isRunningLock }}
      cancelButtonProps={{ disabled: isRunningLock }}
      maskClosable={false}
      transitionName="animation-move-down"
      centered>
      {!progressData && !failed && <div>{t('restore.content')}</div>}
      {failed && <div data-testid="restore-error">{failed}</div>}
      {progressData && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Progress percent={Math.floor(progressData.progress)} strokeColor="var(--color-primary)" />
          <div style={{ marginTop: 16 }}>{getProgressText()}</div>
        </div>
      )}
    </Modal>
  )
}

const TopViewKey = 'RestorePopup'

export default class RestorePopup {
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
