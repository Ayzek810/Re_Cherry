import type { MenuProps } from 'antd'
import type { ReactNode } from 'react'
import { useState } from 'react'

import { LeftMenu, Settings, settingsModalStyles, StyledMenu, StyledModal } from './shared'

export type SettingsPopupTab = 'essential' | 'permission-mode' | 'tools' | 'skills' | 'advanced'

export type SettingsMenuItem = NonNullable<MenuProps['items']>[number] & {
  key: SettingsPopupTab
}

interface BaseSettingsPopupProps {
  initialTab?: SettingsPopupTab
  onClose: () => void
  titleContent: ReactNode
  menuItems: SettingsMenuItem[]
  renderTabContent: (tab: SettingsPopupTab) => ReactNode
}

/**
 * 智能体设置弹窗外壳（移植自 V1 BaseSettingsPopup；数据源为 Redux 同步读取，
 * 无加载/错误态，故去掉 V1 的 isLoading/error 分支）。
 */
export const BaseSettingsPopup: React.FC<BaseSettingsPopupProps> = ({
  initialTab = 'essential',
  onClose,
  titleContent,
  menuItems,
  renderTabContent
}) => {
  const [open, setOpen] = useState(true)
  const [menu, setMenu] = useState<SettingsPopupTab>(initialTab)

  const handleClose = () => {
    setOpen(false)
  }

  const afterClose = () => {
    onClose()
  }

  return (
    <StyledModal
      open={open}
      onOk={handleClose}
      onCancel={handleClose}
      afterClose={afterClose}
      maskClosable={menu !== 'prompt'}
      footer={null}
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
