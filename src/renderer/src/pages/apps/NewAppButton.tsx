import { PlusOutlined, UploadOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import {
  ORIGIN_DEFAULT_MIN_APPS,
  readCustomMiniApps,
  updateAllMinApps,
  updateCustomMiniApps
} from '@renderer/config/minapps'
import { useMinapps } from '@renderer/hooks/useMinapps'
import type { MinAppType } from '@renderer/types'
import { Button, Form, Input, Modal, Radio, Upload } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  size?: number
}

const logger = loggerService.withContext('NewAppButton')

const NewAppButton: FC<Props> = ({ size = 60 }) => {
  const { t } = useTranslation()
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [logoType, setLogoType] = useState<'url' | 'file'>('url')
  const [form] = Form.useForm()
  const { minapps, updateMinapps } = useMinapps()

  const handleLogoTypeChange = (e: any) => {
    setLogoType(e.target.value)
    form.setFieldValue('logo', '')
    setFileList([])
  }

  const handleAddCustomApp = async (values: any) => {
    try {
      // r2-79/⑥：先只读一次做 id 冲突判定（`missing` = 全新安装的合法缺省 → 空列表）；
      // 冲突时**不写盘**。`error`（存在但读不出来）在这里抛出 → 报错且原文件原样保留。
      const existing = await readCustomMiniApps()
      if (existing.status === 'error') {
        throw existing.error
      }
      const currentApps = existing.status === 'ok' ? existing.apps : []

      // Check for duplicate ID
      if (currentApps.some((app) => app.id === values.id)) {
        window.toast.error(t('settings.miniapps.custom.duplicate_ids', { ids: values.id }))
        return
      }
      if (ORIGIN_DEFAULT_MIN_APPS.some((app) => app.id === values.id)) {
        window.toast.error(t('settings.miniapps.custom.conflicting_ids', { ids: values.id }))
        return
      }

      const newApp: MinAppType = {
        id: values.id,
        name: values.name,
        url: values.url,
        logo: form.getFieldValue('logo') || '',
        type: 'Custom',
        addTime: new Date().toISOString()
      }
      // 唯一的写点：对「不存在」从空列表开始建（首次创建），对「读不出来」抛出
      // ——失败绝不长得像空结果，原文件不被覆盖。
      const nextCustomApps = await updateCustomMiniApps((apps) => [...apps, newApp])

      window.toast.success(t('settings.miniapps.custom.save_success'))
      setIsModalVisible(false)
      form.resetFields()
      setFileList([])
      updateAllMinApps([...ORIGIN_DEFAULT_MIN_APPS, ...nextCustomApps])
      updateMinapps([...minapps, newApp])
    } catch (error) {
      logger.error('Failed to save custom mini app:', error as Error)
      window.toast.error(t('settings.miniapps.custom.save_error'))
    }
  }

  const handleFileChange = async (info: any) => {
    const file = info.fileList[info.fileList.length - 1]?.originFileObj
    setFileList(info.fileList.slice(-1))

    if (file) {
      try {
        const reader = new FileReader()
        reader.onload = (event) => {
          const base64Data = event.target?.result
          if (typeof base64Data === 'string') {
            window.toast.success(t('settings.miniapps.custom.logo_upload_success'))
            form.setFieldValue('logo', base64Data)
          }
        }
        // FileReader 的失败是**异步事件**，外层 try/catch 捕获不到（f2-61）。缺了 onerror
        // 时"读不出来"与"用户没选文件"完全同形：既不报错也不成功，保存后得到无图标的小程序。
        reader.onerror = () => {
          logger.error('Failed to read file:', { name: reader.error?.name, message: reader.error?.message })
          window.toast.error(t('settings.miniapps.custom.logo_upload_error'))
        }
        reader.onabort = () => {
          logger.warn('FileReader aborted while reading the mini-app logo')
          window.toast.error(t('settings.miniapps.custom.logo_upload_error'))
        }
        reader.readAsDataURL(file)
      } catch (error) {
        logger.error('Failed to read file:', error as Error)
        window.toast.error(t('settings.miniapps.custom.logo_upload_error'))
      }
    }
  }

  return (
    <>
      <Container onClick={() => setIsModalVisible(true)}>
        <AddButton size={size}>
          <PlusOutlined />
        </AddButton>
        <AppTitle>{t('settings.miniapps.custom.title')}</AppTitle>
      </Container>
      <Modal
        title={t('settings.miniapps.custom.edit_title')}
        open={isModalVisible}
        onCancel={() => {
          setIsModalVisible(false)
          setFileList([])
        }}
        maskClosable={false}
        footer={null}
        transitionName="animation-move-down"
        centered>
        <Form form={form} onFinish={handleAddCustomApp} layout="vertical">
          <Form.Item
            name="id"
            label={t('settings.miniapps.custom.id')}
            rules={[{ required: true, message: t('settings.miniapps.custom.id_error') }]}>
            <Input placeholder={t('settings.miniapps.custom.id_placeholder')} />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('settings.miniapps.custom.name')}
            rules={[{ required: true, message: t('settings.miniapps.custom.name_error') }]}>
            <Input placeholder={t('settings.miniapps.custom.name_placeholder')} />
          </Form.Item>
          <Form.Item
            name="url"
            label={t('settings.miniapps.custom.url')}
            rules={[{ required: true, message: t('settings.miniapps.custom.url_error') }]}>
            <Input placeholder={t('settings.miniapps.custom.url_placeholder')} />
          </Form.Item>
          <Form.Item label={t('settings.miniapps.custom.logo')}>
            <Radio.Group value={logoType} onChange={handleLogoTypeChange}>
              <Radio value="url">{t('settings.miniapps.custom.logo_url')}</Radio>
              <Radio value="file">{t('settings.miniapps.custom.logo_file')}</Radio>
            </Radio.Group>
          </Form.Item>
          {logoType === 'url' ? (
            <Form.Item name="logo" label={t('settings.miniapps.custom.logo_url_label')}>
              <Input placeholder={t('settings.miniapps.custom.logo_url_placeholder')} />
            </Form.Item>
          ) : (
            <Form.Item label={t('settings.miniapps.custom.logo_upload_label')}>
              <Upload
                accept="image/*"
                maxCount={1}
                fileList={fileList}
                onChange={handleFileChange}
                beforeUpload={() => false}>
                <Button icon={<UploadOutlined />}>{t('settings.miniapps.custom.logo_upload_button')}</Button>
              </Upload>
            </Form.Item>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit">
              {t('settings.miniapps.custom.save')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
`

const AddButton = styled.div<{ size?: number }>`
  width: ${({ size }) => size || 60}px;
  height: ${({ size }) => size || 60}px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background-soft);
  border: 1px dashed var(--color-border);
  color: var(--color-text-soft);
  font-size: 24px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-background);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
`

const AppTitle = styled.div`
  font-size: 12px;
  margin-top: 5px;
  color: var(--color-text-soft);
  text-align: center;
  user-select: none;
  white-space: nowrap;
`

export default NewAppButton
