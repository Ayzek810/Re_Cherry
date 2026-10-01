import { Navbar, NavbarMain } from '@renderer/components/app/Navbar'
import App from '@renderer/components/MinApp/MinApp'
import Scrollbar from '@renderer/components/Scrollbar'
import { takeCustomMiniAppsLoadError } from '@renderer/config/minapps'
import { useMinapps } from '@renderer/hooks/useMinapps'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
import { Button, Input } from 'antd'
import { Search, SettingsIcon } from 'lucide-react'
import type { FC } from 'react'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MinappSettingsPopup from './MiniappSettings/MinappSettingsPopup'
import NewAppButton from './NewAppButton'

const AppsPage: FC = () => {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const { minapps } = useMinapps()
  const { isTopNavbar } = useNavbarPosition()

  // /⑥：启动播种失败的提示在这里落地。`config/minapps.ts` 在渲染层启动期求值，
  // 那时 `window.toast` 还没赋值（TopView 在挂载 effect 里才设置）——当场弹 toast 会静默
  // no-op，失败就只剩一条日志。这里在挂载后取走一次性提示并展示（用户正是在这一页管理
  // 自定义小应用，提示落在上下文里）。
  useEffect(() => {
    const loadError = takeCustomMiniAppsLoadError()
    if (loadError) {
      window.toast?.error(loadError)
    }
  }, [])

  const filteredApps = search
    ? minapps.filter(
        (app) => app.name.toLowerCase().includes(search.toLowerCase()) || app.url.includes(search.toLowerCase())
      )
    : minapps

  // Calculate the required number of lines
  const itemsPerRow = Math.floor(930 / 115) // Maximum width divided by the width of each item (including spacing)
  const rowCount = Math.ceil((filteredApps.length + 1) / itemsPerRow) // +1 for the add button
  // Each line height is 85px (60px icon + 5px margin + 12px text + spacing)
  const containerHeight = rowCount * 85 + (rowCount - 1) * 25 // 25px is the line spacing.

  // Disable right-click menu in blank area
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
  }

  return (
    <Container onContextMenu={handleContextMenu}>
      <Navbar>
        <NavbarMain>
          {t('minapp.title')}
          <Input
            placeholder={t('common.search')}
            className="nodrag"
            style={{
              width: '30%',
              height: 28,
              borderRadius: 15
            }}
            size="small"
            variant="filled"
            suffix={<Search size={18} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            type="text"
            className="nodrag"
            icon={<SettingsIcon size={18} color="var(--color-text-2)" />}
            onClick={MinappSettingsPopup.show}
          />
        </NavbarMain>
      </Navbar>
      <ContentContainer id="content-container">
        <MainContainer>
          <RightContainer>
            {isTopNavbar && (
              <HeaderContainer>
                <Input
                  placeholder={t('common.search')}
                  className="nodrag"
                  style={{ width: '30%', borderRadius: 15 }}
                  variant="filled"
                  suffix={<Search size={18} />}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </HeaderContainer>
            )}
            <AppsContainerWrapper>
              <AppsContainer style={{ height: containerHeight }}>
                {filteredApps.map((app) => (
                  <App key={app.id} app={app} />
                ))}
                <NewAppButton />
              </AppsContainer>
            </AppsContainerWrapper>
          </RightContainer>
        </MainContainer>
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  justify-content: center;
  height: 100%;
`

const HeaderContainer = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  height: 60px;
  width: 100%;
  gap: 10px;
`

const MainContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  height: calc(100vh - var(--navbar-height));
  width: 100%;
`

const RightContainer = styled(Scrollbar)`
  display: flex;
  flex: 1 1 0%;
  min-width: 0;
  flex-direction: column;
  height: 100%;
  align-items: center;
  height: calc(100vh - var(--navbar-height));
`

const AppsContainerWrapper = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: row;
  justify-content: center;
  padding: 50px 0;
  width: 100%;
  margin-bottom: 20px;
  [navbar-position='top'] & {
    padding: 20px 0;
  }
`

const AppsContainer = styled.div`
  display: grid;
  min-width: 0;
  max-width: 930px;
  margin: 0 20px;
  width: 100%;
  grid-template-columns: repeat(auto-fill, 90px);
  gap: 25px;
  justify-content: center;
`

export default AppsPage
