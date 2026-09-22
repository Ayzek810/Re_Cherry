import { Button, type MenuProps } from 'antd'
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LeftMenu, Settings, settingsModalStyles, StyledMenu, StyledModal } from './shared'

export type SettingsPopupTab = 'essential' | 'permission-mode' | 'tools' | 'skills' | 'mcp' | 'knowledge' | 'advanced'

export type SettingsMenuItem = NonNullable<MenuProps['items']>[number] & {
  key: SettingsPopupTab
}

interface BaseSettingsPopupProps {
  initialTab?: SettingsPopupTab
  /** confirmed：按「确认」关闭为 true，X / Esc / 点遮罩关闭为 false。
   *  编辑既有助手时它无意义（栏目改动本就即时生效）；新建草稿流程靠它区分"确认建"与"不建"。 */
  onClose: (confirmed: boolean) => void
  titleContent: ReactNode
  menuItems: SettingsMenuItem[]
  renderTabContent: (tab: SettingsPopupTab) => ReactNode
}

/**
 * 智能体设置弹窗外壳（移植自 V1 BaseSettingsPopup；数据源为 Redux 同步读取，
 * 无加载/错误态，故去掉 V1 的 isLoading/error 分支）。
 * v0.3.1-2：补确认键——V1 原样是 footer=null，只能靠 X 关闭，用户要求"加确认键"。
 */
export const BaseSettingsPopup: React.FC<BaseSettingsPopupProps> = ({
  initialTab = 'essential',
  onClose,
  titleContent,
  menuItems,
  renderTabContent
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [menu, setMenu] = useState<SettingsPopupTab>(initialTab)
  const confirmedRef = useRef(false)

  const handleConfirm = () => {
    confirmedRef.current = true
    setOpen(false)
  }

  const handleCancel = () => {
    setOpen(false)
  }

  const afterClose = () => {
    onClose(confirmedRef.current)
  }

  return (
    <StyledModal
      open={open}
      onOk={handleConfirm}
      onCancel={handleCancel}
      afterClose={afterClose}
      footer={
        <div className="flex justify-end">
          <Button type="primary" onClick={handleConfirm}>
            {t('common.confirm')}
          </Button>
        </div>
      }
      title={titleContent}
      transitionName="animation-move-down"
      styles={settingsModalStyles}
      width="min(900px, 70vw)"
      centered>
      <div className="flex w-full flex-1">
        <LeftMenu>
          <StyledMenu
            defaultSelectedKeys={[initialTab]}
            mode="vertical"
            selectedKeys={[menu]}
            items={menuItems}
            onSelect={({ key }) => setMenu(key as SettingsPopupTab)}
          />
        </LeftMenu>
        <Settings>{renderTabContent(menu)}</Settings>
      </div>
    </StyledModal>
  )
}
