import PrivacyPopup from '@renderer/components/Popups/PrivacyPopup'
import { TopView } from '@renderer/components/TopView'
import { LATEST_PRIVACY_POLICY_VERSION } from '@renderer/config/constant'
import { useAppDispatch } from '@renderer/store'
import { setPrivacyPolicyVersion } from '@renderer/store/settings'
import { Button, Modal } from 'antd'
import type { FC } from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  resolve: (data: any) => void
}

const PopupContainer: FC<Props> = ({ resolve }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(true)

  const acknowledgeLatestPrivacyPolicy = useCallback(() => {
    dispatch(setPrivacyPolicyVersion(LATEST_PRIVACY_POLICY_VERSION))
    // v0.3.1-2：上游在此对 "20260531" 版政策做了一次性**强制重置**——把
    // [设置]-[通用]-[隐私设置] 各开关一律置回默认**开**（含数据收集），从而把用户已关闭的开关
    // 重新打开、继续向 cherry-studio 通道上报。本 fork 不再执行该重置：政策版本号照常记录，
    // 用户自己的开关选择不被覆盖。
  }, [dispatch])

  const handleShowPrivacyPolicy = useCallback(() => {
    setOpen(false)
    void PrivacyPopup.show({
      acceptButtonText: t('common.i_know'),
      force: true,
      modal: true,
      onAccepted: acknowledgeLatestPrivacyPolicy,
      quitOnDecline: false,
      showDeclineButton: false
    })
  }, [acknowledgeLatestPrivacyPolicy, t])

  const handleAcknowledge = useCallback(() => {
    acknowledgeLatestPrivacyPolicy()
    setOpen(false)
  }, [acknowledgeLatestPrivacyPolicy])

  const onClose = () => {
    resolve({})
  }

  PrivacyPolicyUpdateNotice.hide = () => setOpen(false)

  return (
    <Modal
      title={t('privacy_policy_update.title')}
      open={open}
      afterClose={onClose}
      transitionName="animation-move-down"
      centered
      closable={false}
      keyboard={false}
      maskClosable={false}
      footer={
        <Button type="primary" onClick={handleAcknowledge}>
          {t('common.i_know')}
        </Button>
      }>
      <div>
        {t('privacy_policy_update.description_before_link')}
        <Button type="link" onClick={handleShowPrivacyPolicy} style={{ padding: 0, height: 'auto' }}>
          {t('privacy_policy_update.policy')}
        </Button>
      </div>
    </Modal>
  )
}

const TopViewKey = 'PrivacyPolicyUpdateNotice'

export default class PrivacyPolicyUpdateNotice {
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
