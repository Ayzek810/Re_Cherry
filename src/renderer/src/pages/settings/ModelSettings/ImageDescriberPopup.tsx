import { ResetIcon } from '@renderer/components/Icons'
import { HStack } from '@renderer/components/Layout'
import { useDefaultModel } from '@renderer/hooks/useAssistant'
import { useAppDispatch } from '@renderer/store'
import { setImageDescriberPrompt } from '@renderer/store/llm'
import { DEFAULT_IMAGE_DESCRIBE_PROMPT } from '@shared/config/imageDescriber'
import { Button, Flex, Input, Modal } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../../../components/TopView'
import { SettingSubtitle } from '..'

interface Props {
  resolve: (data: any) => void
}

/**
 * 转述模型设置弹窗（照 QuickModelPopup/TopicNamingModalPopup 形态）：
 * 唯一可编辑项 = 转述提示词。'' = 内置默认；文本框常显当前生效值，
 * 改完即时入 store（useAppInit effect 自动推内核）。
 */
const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const { t } = useTranslation()
  const { imageDescriberPrompt } = useDefaultModel()
  const dispatch = useAppDispatch()

  const onCancel = () => setOpen(false)
  const onClose = () => resolve({})

  const handleReset = () => {
    dispatch(setImageDescriberPrompt(''))
  }

  ImageDescriberPopup.hide = onCancel

  return (
    <Modal
      title={t('settings.models.image_describer.setting_title')}
      open={open}
      footer={null}
      onCancel={onCancel}
      afterClose={onClose}
      maskClosable={false}
      transitionName="animation-move-down"
      centered
      style={{ padding: '24px' }}>
      <Flex vertical align="stretch" gap={8}>
        <SettingSubtitle style={{ marginTop: 0, marginBottom: 8 }}>
          {t('settings.models.image_describer.label')}
        </SettingSubtitle>
        <div>
          <HStack style={{ gap: 6, marginBottom: 4, height: 30 }} alignItems="center">
            <div>{t('settings.models.image_describer.prompt')}</div>
            {imageDescriberPrompt ? <Button icon={<ResetIcon size={14} />} onClick={handleReset} type="text" /> : null}
          </HStack>
          <Input.TextArea
            autoSize={{ minRows: 8, maxRows: 16 }}
            value={imageDescriberPrompt || DEFAULT_IMAGE_DESCRIBE_PROMPT}
            onChange={(e) => dispatch(setImageDescriberPrompt(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
      </Flex>
    </Modal>
  )
}

const TopViewKey = 'ImageDescriberPopup'

export default class ImageDescriberPopup {
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
