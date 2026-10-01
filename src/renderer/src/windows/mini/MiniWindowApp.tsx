import '@renderer/databases'

import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { getToastUtilities } from '@renderer/components/TopView/toast'
import { useInjectCustomCss } from '@renderer/hooks/useInjectCustomCss'
import { useSettings } from '@renderer/hooks/useSettings'
import store, { persistor } from '@renderer/store'
import { useEffect } from 'react'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'

import AntdProvider from '../../context/AntdProvider'
import { CodeStyleProvider } from '../../context/CodeStyleProvider'
import { ThemeProvider } from '../../context/ThemeProvider'
import HomeWindow from './home/HomeWindow'

// Inner component that uses the hook after Redux is initialized
function MiniWindowContent(): React.ReactElement {
  const { customCss } = useSettings()

  // 与主窗口共用同一份注入实现（此前两端各写一遍，任一侧修改都会漂移）。
  useInjectCustomCss(customCss)

  return <HomeWindow />
}

function MiniWindow(): React.ReactElement {
  useEffect(() => {
    window.toast = getToastUtilities()
  }, [])

  return (
    <Provider store={store}>
      <ThemeProvider>
        <AntdProvider>
          <CodeStyleProvider>
            {/* ：小窗保留 PersistGate 只是为了等"从主窗口快照 rehydrate 完成"这一次读取；
                本窗口的 persistor 已被 `miniWindowStoreRole` 暂停，不会回写 localStorage。 */}
            <PersistGate loading={null} persistor={persistor}>
              <ErrorBoundary>
                <MiniWindowContent />
              </ErrorBoundary>
            </PersistGate>
          </CodeStyleProvider>
        </AntdProvider>
      </ThemeProvider>
    </Provider>
  )
}

export default MiniWindow
