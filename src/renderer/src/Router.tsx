import '@renderer/databases'

import type { FC } from 'react'
import { useMemo } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'

import Sidebar from './components/app/Sidebar'
import { ErrorBoundary } from './components/ErrorBoundary'
import TabsContainer from './components/Tab/TabContainer'
import NavigationHandler from './handler/NavigationHandler'
import { useOnboardingState } from './hooks/useOnboardingState'
import { useNavbarPosition } from './hooks/useSettings'
import MinAppPage from './pages/apps/MinAppPage'
import MinAppsPage from './pages/apps/MinAppsPage'
import CodeCliPage from './pages/code/CodeCliPage'
import FilesPage from './pages/files/FilesPage'
import HomePage from './pages/home/HomePage'
import KnowledgePage from './pages/knowledge/KnowledgePage'
import LaunchpadPage from './pages/launchpad/LaunchpadPage'
import NotesPage from './pages/notes/NotesPage'
import { OnboardingPage } from './pages/onboarding'
import PaintingPage from './pages/paintings/PaintingPage'
import SettingsPage from './pages/settings/SettingsPage'
import TranslatePage from './pages/translate/TranslatePage'

const Router: FC = () => {
  const { onboardingCompleted, completeOnboarding } = useOnboardingState()
  const { navbarPosition } = useNavbarPosition()

  const routes = useMemo(() => {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/launchpad" element={<LaunchpadPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/translate" element={<TranslatePage />} />
          <Route path="/paintings" element={<PaintingPage />} />
          {/* v0.3.3-2 笔记复活（V1 原样） */}
          <Route path="/notes" element={<NotesPage />} />
          {/* v0.3.4 小程序页面（V1 原样：列表页 + 详情壳） */}
          <Route path="/apps/:appId" element={<MinAppPage />} />
          <Route path="/apps" element={<MinAppsPage />} />
          {/* v0.3.4-1 编码助手（Code Mate，V2 移植） */}
          <Route path="/code" element={<CodeCliPage />} />
        </Routes>
      </ErrorBoundary>
    )
  }, [])

  if (!onboardingCompleted) {
    return <OnboardingPage onComplete={completeOnboarding} />
  }

  if (navbarPosition === 'left') {
    return (
      <HashRouter>
        <Sidebar />
        {routes}
        <NavigationHandler />
      </HashRouter>
    )
  }

  return (
    <HashRouter>
      <NavigationHandler />
      <TabsContainer>{routes}</TabsContainer>
    </HashRouter>
  )
}

export default Router
