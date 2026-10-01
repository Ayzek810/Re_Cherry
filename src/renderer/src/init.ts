import KeyvStorage from '@kangfenmao/keyv-storage'
import { loggerService } from '@logger'

import { startAutoSync } from './services/BackupService'
import { startNutstoreAutoSync } from './services/NutstoreService'
import storeSyncService from './services/StoreSyncService'
import { default as store, persistor } from './store'

const logger = loggerService.withContext('init')

loggerService.initWindowSource('mainWindow')

function initKeyv() {
  window.keyv = new KeyvStorage()
  void window.keyv.init()
}

function initAutoSync() {
  setTimeout(() => {
    const { webdavAutoSync, localBackupAutoSync, s3 } = store.getState().settings
    const { nutstoreAutoSync } = store.getState().nutstore
    if (webdavAutoSync || (s3 && s3.autoSync) || localBackupAutoSync) {
      startAutoSync()
    }
    if (nutstoreAutoSync) {
      void startNutstoreAutoSync()
    }
  }, 8000)
}

function initStoreSync() {
  storeSyncService.subscribe()
}

/**
 * 按需初始化渲染层 trace（v1 二轮性能审计 p2-05）。
 *
 * 此前无条件 `webTraceService.init()` 会在**每个**窗口启动时构造
 * `FunctionSpanExporter` + `FunctionSpanProcessor` 并 `WebTracer.init()`，把
 * `@opentelemetry/sdk-trace-web` 的运行期初始化压到所有用户身上；而消费侧
 * `SpanManagerService` 的 5 个入口与 `SpanCacheService.saveEntity` 首行都以
 * `getEnableDeveloperMode()` 为门（非开发者模式下整条链路的结果被丢弃）。
 *
 * 现在：等 redux-persist rehydrate 落定后读 `settings.enableDeveloperMode`，只有为真才
 * 动态导入并初始化。`enableDeveloperMode` 是持久化字段，rehydrate 之前读它只会拿到
 * `initialState` 的 `false`（会把开发者错误地关掉 trace），所以门禁必须挂在 bootstrapped 之后。
 * `webTraceService.init()` 自身幂等（见 WebTraceService），重复触发安全。
 */
function initWebTraceWhenEnabled() {
  const maybeInit = () => {
    if (!persistor.getState().bootstrapped) return
    unsubscribe()
    if (!store.getState().settings.enableDeveloperMode) return
    void import('./services/WebTraceService').then(({ webTraceService }) => {
      webTraceService.init()
      logger.info('Web trace initialized (developer mode)')
    })
  }
  const unsubscribe = persistor.subscribe(maybeInit)
  maybeInit()
}

initKeyv()
initAutoSync()
initStoreSync()
initWebTraceWhenEnabled()
