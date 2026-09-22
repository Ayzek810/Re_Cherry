import '@renderer/databases'

import { loggerService } from '@logger'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import PersistLoadingFallback from '@renderer/components/PersistLoadingFallback'
import store, { persistor } from '@renderer/store'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import TopViewContainer from './components/TopView'
import AntdProvider from './context/AntdProvider'
import { CodeStyleProvider } from './context/CodeStyleProvider'
import { NotificationProvider } from './context/NotificationProvider'
import StyleSheetManager from './context/StyleSheetManager'
import { ThemeProvider } from './context/ThemeProvider'
import BootConfigSync from './hooks/useBootConfigSync'
import Router from './Router'

const logger = loggerService.withContext('App.tsx')

// 创建 React Query 客户端
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false
    }
  }
})

/**
 * v0.3.1-2：白屏护栏（详见 docs）。占位组件见 components/PersistLoadingFallback。
 */
function App(): React.ReactElement {
  logger.info('App initialized')

  return (
    <Provider store={store}>
      {/* v0.3.1-2：顶层错误边界。此前渲染期抛错（hook 契约违规、持久化形态不匹配等）
          会整窗空白、没有任何线索，只能靠人工猜。现在至少显示错误文本，并给出
          「打开 DevTools / 重新加载」。 */}
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <StyleSheetManager>
            <ThemeProvider>
              <AntdProvider>
                <NotificationProvider>
                  <CodeStyleProvider>
                    <PersistGate loading={<PersistLoadingFallback />} persistor={persistor}>
                      <BootConfigSync />
                      <TopViewContainer>
                        <Router />
                      </TopViewContainer>
                    </PersistGate>
                  </CodeStyleProvider>
                </NotificationProvider>
              </AntdProvider>
            </ThemeProvider>
          </StyleSheetManager>
        </QueryClientProvider>
      </ErrorBoundary>
    </Provider>
  )
}

export default App
