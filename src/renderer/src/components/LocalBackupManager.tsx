import { DeleteOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { restoreFromLocal } from '@renderer/services/BackupService'
import { formatFileSize } from '@renderer/utils'
import { Button, message, Modal, Space, Table, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('LocalBackupManager')

interface BackupFile {
  fileName: string
  modifiedTime: string
  size: number
}

interface LocalBackupManagerProps {
  visible: boolean
  onClose: () => void
  localBackupDir?: string
  restoreMethod?: (fileName: string) => Promise<void>
}

export function LocalBackupManager({ visible, onClose, localBackupDir, restoreMethod }: LocalBackupManagerProps) {
  const { t } = useTranslation()
  const [backupFiles, setBackupFiles] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [deleting, setDeleting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 5,
    total: 0
  })
  const fetchBackupFiles = useCallback(async () => {
    if (!localBackupDir) {
      return
    }

    setLoading(true)
    try {
      const files = await window.api.backup.listLocalBackupFiles(localBackupDir)
      setBackupFiles(files)
      setPagination((prev) => ({
        ...prev,
        total: files.length
      }))
    } catch (error: any) {
      window.toast.error(`${t('settings.data.local.backup.manager.fetch.error')}: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }, [localBackupDir, t])

  useEffect(() => {
    if (visible) {
      void fetchBackupFiles()
      setSelectedRowKeys([])
      setPagination((prev) => ({
        ...prev,
        current: 1
      }))
    }
  }, [visible, fetchBackupFiles])

  const handleTableChange = (pagination: any) => {
    setPagination(pagination)
  }

  const handleDeleteSelected = async () => {
    if (selectedRowKeys.length === 0) {
      message.warning(t('settings.data.local.backup.manager.select.files.delete'))
      return
    }

    if (!localBackupDir) {
      return
    }

    window.modal.confirm({
      title: t('settings.data.local.backup.manager.delete.confirm.title'),
      icon: <ExclamationCircleOutlined />,
      content: t('settings.data.local.backup.manager.delete.confirm.multiple', { count: selectedRowKeys.length }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk: async () => {
        setDeleting(true)
        // 批量删除必须报「N 成功 / M 失败」。原实现把串行 await 放在同一个 try 里，
        // 第 k 条失败即跳出：前 k-1 条已经真删了、后面的没删，却只弹一条通用错误，
        // 用户无法知道到底删掉了几个；`selectedRowKeys` 也只在全成功路径才清空。
        const requestedKeys = [...selectedRowKeys]
        const results = await Promise.allSettled(
          requestedKeys.map((key) => window.api.backup.deleteLocalBackupFile(key.toString(), localBackupDir))
        )

        const succeededKeys = requestedKeys.filter((_, index) => results[index].status === 'fulfilled')
        const failedResults = results.filter((result) => result.status === 'rejected')

        if (failedResults.length > 0) {
          logger.error(
            `Failed to delete ${failedResults.length} of ${requestedKeys.length} backup files`,
            failedResults[0].reason as Error
          )
          window.toast.error(
            t('settings.data.local.backup.manager.delete.partial', {
              succeeded: succeededKeys.length,
              failed: failedResults.length,
              total: requestedKeys.length,
              defaultValue: 'Deleted {{succeeded}} of {{total}} backup files. {{failed}} failed.'
            })
          )
        } else {
          window.toast.success(
            t('settings.data.local.backup.manager.delete.success.multiple', { count: succeededKeys.length })
          )
        }

        // 只保留真正没删掉的那些，用户可以直接重试。
        setSelectedRowKeys(requestedKeys.filter((_, index) => results[index].status === 'rejected'))
        await fetchBackupFiles()
        setDeleting(false)
      }
    })
  }

  const handleDeleteSingle = async (fileName: string) => {
    if (!localBackupDir) {
      return
    }

    window.modal.confirm({
      title: t('settings.data.local.backup.manager.delete.confirm.title'),
      icon: <ExclamationCircleOutlined />,
      content: t('settings.data.local.backup.manager.delete.confirm.single', { fileName }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk: async () => {
        setDeleting(true)
        try {
          await window.api.backup.deleteLocalBackupFile(fileName, localBackupDir)
          message.success(t('settings.data.local.backup.manager.delete.success.single'))
          await fetchBackupFiles()
        } catch (error: any) {
          window.toast.error(`${t('settings.data.local.backup.manager.delete.error')}: ${error.message}`)
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  const handleRestore = async (fileName: string) => {
    if (!localBackupDir) {
      return
    }

    window.modal.confirm({
      title: t('settings.data.local.restore.confirm.title'),
      icon: <ExclamationCircleOutlined />,
      content: t('settings.data.local.restore.confirm.content'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk: async () => {
        setRestoring(true)
        try {
          await (restoreMethod || restoreFromLocal)(fileName)
          message.success(t('settings.data.local.backup.manager.restore.success'))
          onClose() // Close the modal
        } catch (error: any) {
          window.toast.error(`${t('settings.data.local.backup.manager.restore.error')}: ${error.message}`)
        } finally {
          setRestoring(false)
        }
      }
    })
  }

  const columns = [
    {
      title: t('settings.data.local.backup.manager.columns.fileName'),
      dataIndex: 'fileName',
      key: 'fileName',
      ellipsis: {
        showTitle: false
      },
      render: (fileName: string) => (
        <Tooltip placement="topLeft" title={fileName}>
          {fileName}
        </Tooltip>
      )
    },
    {
      title: t('settings.data.local.backup.manager.columns.modifiedTime'),
      dataIndex: 'modifiedTime',
      key: 'modifiedTime',
      width: 180,
      render: (time: string) => dayjs(time).format('YYYY-MM-DD HH:mm:ss')
    },
    {
      title: t('settings.data.local.backup.manager.columns.size'),
      dataIndex: 'size',
      key: 'size',
      width: 120,
      render: (size: number) => formatFileSize(size)
    },
    {
      title: t('settings.data.local.backup.manager.columns.actions'),
      key: 'action',
      width: 160,
      render: (_: any, record: BackupFile) => (
        <>
          <Button type="link" onClick={() => handleRestore(record.fileName)} disabled={restoring || deleting}>
            {t('settings.data.local.backup.manager.restore.text')}
          </Button>
          <Button
            type="link"
            danger
            onClick={() => handleDeleteSingle(record.fileName)}
            disabled={deleting || restoring}>
            {t('settings.data.local.backup.manager.delete.text')}
          </Button>
        </>
      )
    }
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (selectedRowKeys: React.Key[]) => {
      setSelectedRowKeys(selectedRowKeys)
    }
  }

  const footerContent = (
    <Space align="center">
      <Button key="refresh" icon={<ReloadOutlined />} onClick={fetchBackupFiles} disabled={loading}>
        {t('settings.data.local.backup.manager.refresh')}
      </Button>
      <Button
        key="delete"
        data-testid="local-backup-delete-selected"
        danger
        icon={<DeleteOutlined />}
        onClick={handleDeleteSelected}
        disabled={selectedRowKeys.length === 0 || deleting}
        loading={deleting}>
        {t('settings.data.local.backup.manager.delete.selected')} ({selectedRowKeys.length})
      </Button>
      <Button key="close" onClick={onClose}>
        {t('common.close')}
      </Button>
    </Space>
  )

  return (
    <Modal
      title={t('settings.data.local.backup.manager.title')}
      open={visible}
      onCancel={onClose}
      width={800}
      centered
      transitionName="animation-move-down"
      footer={footerContent}>
      <Table
        rowKey="fileName"
        columns={columns}
        dataSource={backupFiles}
        rowSelection={rowSelection}
        pagination={pagination}
        loading={loading}
        onChange={handleTableChange}
        size="middle"
      />
    </Modal>
  )
}
