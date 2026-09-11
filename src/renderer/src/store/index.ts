/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { loggerService } from '@logger'
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { useDispatch, useSelector, useStore } from 'react-redux'
import {
  createTransform,
  FLUSH,
  PAUSE,
  PERSIST,
  persistReducer,
  persistStore,
  PURGE,
  REGISTER,
  REHYDRATE
} from 'redux-persist'
import storage from 'redux-persist/lib/storage'

import storeSyncService from '../services/StoreSyncService'
import assistants from './assistants'
import backup from './backup'
import copilot from './copilot'
import inputToolsReducer from './inputTools'
import llm, { updateProviders } from './llm'
import memory from './memory'
import messageBlocksReducer from './messageBlock'
import migrate from './migrate'
import minapps from './minapps'
import newMessagesReducer from './newMessage'
import nutstore from './nutstore'
import runtime from './runtime'
import settings from './settings'
import shortcuts from './shortcuts'
import tabs from './tabs'
import toolPermissions from './toolPermissions'

const logger = loggerService.withContext('Store')

const rootReducer = combineReducers({
  assistants,
  backup,
  nutstore,
  llm,
  settings,
  runtime,
  shortcuts,
  minapps,
  memory,
  copilot,
  tabs,
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  inputTools: inputToolsReducer,
  toolPermissions
})

// v0.2.4 K3：写盘前剥离非空 provider apiKey（明文不落 localStorage）。
// 仅删除非空密钥 —— 空串/缺省字段保留，保证 rehydrate 后 apiKey 字段语义不变；
// 运行时内存仍持有 key（跨窗口 StoreSync 语义不变），K4 启动时从 main 加密存储回填。
const stripProviderApiKeys = createTransform<any, any>(
  (inboundState) => inboundState,
  (outboundState, key) => {
    // 整个 rootReducer 一起持久化：transform 会按顶层 key 逐个调用，只处理 llm 切片
    if (key !== 'llm') return outboundState
    const llm = outboundState as {
      providers?: Array<Record<string, unknown>>
    } | null
    if (!llm || typeof llm !== 'object' || !Array.isArray(llm.providers)) return outboundState
    let changed = false
    const providers = llm.providers.map((p) => {
      if (p && typeof p === 'object' && typeof p.apiKey === 'string' && p.apiKey.length > 0) {
        changed = true
        const rest = { ...p }
        delete (rest as { apiKey?: unknown }).apiKey
        return rest
      }
      return p
    })
    if (!changed) return outboundState
    return { ...llm, providers }
  }
)

const persistedReducer = persistReducer<ReturnType<typeof rootReducer>>(
  {
    key: 'cherry-studio',
    storage,
    version: 213,
    blacklist: ['runtime', 'messages', 'messageBlocks', 'tabs', 'toolPermissions'],
    transforms: [stripProviderApiKeys],
    migrate
  },
  rootReducer
)

/**
 * Configures the store sync service to synchronize specific state slices across all windows.
 * For detailed implementation, see @renderer/services/StoreSyncService.ts
 *
 * Usage:
 * - 'xxxx/' - Synchronizes the entire state slice
 * - 'xxxx/sliceName' - Synchronizes a specific slice within the state
 *
 * To listen for store changes in a window:
 * Call storeSyncService.subscribe() in the window's entryPoint.tsx
 */
storeSyncService.setOptions({
  syncList: ['assistants/', 'settings/', 'llm/']
})

const store = configureStore({
  // @ts-ignore store type is unknown
  reducer: persistedReducer as typeof rootReducer,
  middleware: (getDefaultMiddleware) => {
    return getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER]
      }
    }).concat(storeSyncService.createMiddleware())
  },
  devTools: true
})

export type RootState = ReturnType<typeof rootReducer>
export type AppDispatch = typeof store.dispatch

export const persistor = persistStore(store, undefined, () => {
  // v0.2.4-1：原 ReduxStoreReady invoke 已删除（main 侧 handler 随 ReduxService 一并移除）
  // v0.2.4 K4：rehydrate 完成后从 main 加密存储回填 provider key（本地持久层已不再落明文）
  void backfillProviderKeysFromVault()
  logger.info('Redux store ready')
})

/** v0.2.4 K4：启动回填 —— main 加密存储（ProviderKeyStore）是 key 的持久真源。
 * rehydrate 后按 providerId 把 key 注入 redux（运行态语义与旧版一致），
 * 并对已删除/迁移过滤的 provider 清掉 main 侧残留 key。 */
async function backfillProviderKeysFromVault(): Promise<void> {
  try {
    if (!window.api?.providerKeys) return
    const keys = await window.api.providerKeys.getAll()
    if (!keys) return
    const entries = (Object.entries(keys) as Array<[string, string]>).filter(([, v]) => v.length > 0)
    if (entries.length === 0) return
    const state = store.getState() as { llm: { providers?: Array<{ id: string; apiKey?: string }> } }
    const providers = state.llm.providers ?? []
    if (providers.length === 0) return
    const ids = new Set(providers.map((p) => p.id))
    let changed = false
    const next = providers.map((p) => {
      const key = keys[p.id]
      if (key && p.apiKey !== key) {
        changed = true
        return { ...p, apiKey: key }
      }
      return p
    })
    // 已删除/迁移过滤的 provider → 清掉 main 侧残留 key
    for (const [id] of entries) {
      if (!ids.has(id)) void window.api.providerKeys.remove(id)
    }
    if (changed) store.dispatch(updateProviders(next as never[]))
  } catch (error) {
    logger.warn('backfillProviderKeysFromVault failed', error instanceof Error ? error : new Error(String(error)))
  }
}

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
export const useAppStore = useStore.withTypes<typeof store>()
window.store = store

export async function handleSaveData() {
  logger.info('Flushing redux persistor data')
  await persistor.flush()
  logger.info('Flushed redux persistor data')
}

export default store
