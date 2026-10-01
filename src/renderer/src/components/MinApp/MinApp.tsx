import { loggerService } from '@logger'
import MinAppIcon from '@renderer/components/Icons/MinAppIcon'
import IndicatorLight from '@renderer/components/IndicatorLight'
import MarqueeText from '@renderer/components/MarqueeText'
import { ORIGIN_DEFAULT_MIN_APPS, updateAllMinApps, updateCustomMiniApps } from '@renderer/config/minapps'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMinapps } from '@renderer/hooks/useMinapps'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { setOpenedKeepAliveMinapps } from '@renderer/store/runtime'
import type { MinAppType } from '@renderer/types'
import type { MenuProps } from 'antd'
import { Dropdown } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

interface Props {
  app: MinAppType
  onClick?: () => void
  size?: number
  isLast?: boolean
}

const logger = loggerService.withContext('App')

const MinApp: FC<Props> = ({ app, onClick, size = 60, isLast }) => {
  const { openMinappKeepAlive } = useMinappPopup()
  const { t } = useTranslation()
  const { minapps, pinned, disabled, updateMinapps, updateDisabledMinapps, updatePinnedMinapps } = useMinapps()
  const { openedKeepAliveMinapps, currentMinappId, minappShow } = useRuntime()
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const isPinned = pinned.some((p) => p.id === app.id)
  const isVisible = minapps.some((m) => m.id === app.id)
  // Pinned apps should always be visible regardless of region/locale filtering
  const shouldShow = isVisible || isPinned
  const isActive = minappShow && currentMinappId === app.id
  const isOpened = openedKeepAliveMinapps.some((item) => item.id === app.id)
  const { isTopNavbar } = useNavbarPosition()

  // Calculate display name
  const displayName = isLast ? t('settings.miniapps.custom.title') : app.nameKey ? t(app.nameKey) : app.name

  const handleClick = () => {
    // fork 缝：code-mate 受管 Web UI 的磁贴是 /code 管理页的快捷方式——
    // 点击进管理页做全新启动，而非按 url 开 webview（transient 应用的 url 是上次
    // 会话的陈旧端口，且未启动时根本没有 url）。启动台/顶栏/侧栏三个消费面统一。
    if (app.id.startsWith('code-mate-')) {
      navigate('/code')
      onClick?.()
      return
    }
    if (isTopNavbar) {
      // 顶部导航栏：导航到小程序页面
      navigate(`/apps/${app.id}`)
    } else {
      // 侧边导航栏：保持原有弹窗行为
      openMinappKeepAlive(app)
    }
    onClick?.()
  }

  const menuItems: MenuProps['items'] = [
    {
      key: 'togglePin',
      label: isPinned
        ? isTopNavbar
          ? t('minapp.remove_from_launchpad')
          : t('minapp.remove_from_sidebar')
        : isTopNavbar
          ? t('minapp.add_to_launchpad')
          : t('minapp.add_to_sidebar'),
      onClick: () => {
        const newPinned = isPinned ? pinned.filter((item) => item.id !== app.id) : [...pinned, app]
        updatePinnedMinapps(newPinned)
      }
    },
    {
      key: 'hide',
      label: t('minapp.sidebar.hide.title'),
      onClick: () => {
        const newMinapps = minapps.filter((item) => item.id !== app.id)
        updateMinapps(newMinapps)
        const newDisabled = [...(disabled || []), app]
        updateDisabledMinapps(newDisabled)
        updatePinnedMinapps(pinned.filter((item) => item.id !== app.id))
        // 更新 openedKeepAliveMinapps
        const newOpenedKeepAliveMinapps = openedKeepAliveMinapps.filter((item) => item.id !== app.id)
        dispatch(setOpenedKeepAliveMinapps(newOpenedKeepAliveMinapps))
      }
    },
    ...(app.type === 'Custom'
      ? [
          {
            key: 'removeCustom',
            label: t('minapp.sidebar.remove_custom.title'),
            danger: true,
            onClick: async () => {
              try {
                // /⑥：删除走同一个写点。此前直接 `read` + `JSON.parse`：全新安装下
                // （还没有 custom-minapps.json）读抛通用错误 → 用户看到"移除失败"，
                // 而实际上这时候 redux 侧本来就没有任何自定义应用可删。
                // `missing` 现在是合法缺省（从空列表开始），`error`（读不出来）仍抛出且不写盘。
                const nextCustomApps = await updateCustomMiniApps((customApps) =>
                  customApps.filter((customApp) => customApp.id !== app.id)
                )
                window.toast.success(t('settings.miniapps.custom.remove_success'))
                updateAllMinApps([...ORIGIN_DEFAULT_MIN_APPS, ...nextCustomApps])
                updateMinapps(minapps.filter((item) => item.id !== app.id))
                updatePinnedMinapps(pinned.filter((item) => item.id !== app.id))
                updateDisabledMinapps(disabled.filter((item) => item.id !== app.id))
              } catch (error) {
                window.toast.error(t('settings.miniapps.custom.remove_error'))
                logger.error('Failed to remove custom mini app:', error as Error)
              }
            }
          }
        ]
      : [])
  ]

  if (!shouldShow) {
    return null
  }

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
      <Container onClick={handleClick}>
        <IconContainer>
          <MinAppIcon size={size} app={app} />
          {isOpened && (
            <StyledIndicator>
              <IndicatorLight color="#22c55e" size={6} animation={!isActive} />
            </StyledIndicator>
          )}
        </IconContainer>
        <AppTitle>
          <MarqueeText>{displayName}</MarqueeText>
        </AppTitle>
      </Container>
    </Dropdown>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  overflow: hidden;
  min-height: 85px;
`

const IconContainer = styled.div`
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
`

const StyledIndicator = styled.div`
  position: absolute;
  bottom: -2px;
  right: -2px;
  padding: 2px;
  background: var(--color-background);
  border-radius: 50%;
`

const AppTitle = styled.div`
  font-size: 12px;
  margin-top: 5px;
  color: var(--color-text-soft);
  text-align: center;
  user-select: none;
  width: 100%;
  max-width: 80px;
`

export default MinApp
