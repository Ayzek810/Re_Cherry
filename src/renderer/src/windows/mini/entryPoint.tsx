import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'
import '@ant-design/v5-patch-for-react-19'

import KeyvStorage from '@kangfenmao/keyv-storage'
import { loggerService } from '@logger'
import storeSyncService from '@renderer/services/StoreSyncService'
import { persistor } from '@renderer/store'
import { createRoot } from 'react-dom/client'

import MiniWindowApp from './MiniWindowApp'
import { configureMiniWindowStoreRole } from './miniWindowStoreRole'

loggerService.initWindowSource('MiniWindow')

/**
 *  This function is required for model API
 *    eg. BaseProviders.ts
 *  Although the coupling is too strong, we have no choice but to load it
 *  In multi-window handling, decoupling is needed
 */
function initKeyv() {
  window.keyv = new KeyvStorage()
  void window.keyv.init()
}
initKeyv()

// r2-03：小窗只读 + 只收（不与主窗口争抢同一个 localStorage persistor）。必须在任何渲染之前执行：
// persistStore 的 rehydrate 是异步的，这里同步 pause 之后本窗口不会有任何回写。
configureMiniWindowStoreRole(persistor, storeSyncService)

//subscribe to store sync
storeSyncService.subscribe()

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<MiniWindowApp />)
