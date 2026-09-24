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
import { noteRestoredTopicIds } from '@renderer/utils/topicBranch'
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
import knowledge from './knowledge'
import llm, { updateProviders } from './llm'
import mcp from './mcp'
import memory from './memory'
import messageBlocksReducer from './messageBlock'
import migrate from './migrate'
import minapps from './minapps'
import newMessagesReducer from './newMessage'
import note, { setNotesPath } from './note'
import nutstore from './nutstore'
import preprocess from './preprocess'
import runtime from './runtime'
import settings from './settings'
import shortcuts from './shortcuts'
import skills from './skills'
import tabs from './tabs'
import toolPermissions from './toolPermissions'
import userQuestions from './userQuestions'
import websearch from './websearch'

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
  toolPermissions,
  userQuestions,
  // v0.3.2 加回四功能的状态切片（批次1 仅 UI 持久化；机制批次 2/3/4/5 接线）
  websearch,
  mcp,
  knowledge,
  skills,
  // v0.3.2 验收轮：文档预处理服务商配置（设置页 /settings/preprocess 编辑）
  preprocess,
  // v0.3.3-2 笔记（V1 原样移植）：笔记目录 + 排序/展开等 UI 态（notesPath 由启动时 App_Info 补）
  note
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
    version: 221,
    blacklist: ['runtime', 'messages', 'messageBlocks', 'tabs', 'toolPermissions', 'userQuestions'],
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
  syncList: ['assistants/', 'settings/', 'llm/', 'note/']
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
  void recordRestoredTopicIds()
  void backfillProviderKeysFromVault()
  // v0.3.3-2 笔记：rehydrate 后若笔记目录为空，用主进程 App_Info 的 notesPath 补上（V1 同形）。
  // 失败只记日志：笔记页自己有"未配置目录"的兜底提示，不因这一条挡住启动。
  void initializeNotesPath()
  logger.info('Redux store ready')
})

/** v0.3.3-2：笔记根目录来自主进程（`{userData}/Data/Notes` 或用户自选目录），只在缺省时注入。
 *  延后一个宏任务（V1 同形）：不在 persist 回调里同步 dispatch，确保 store 已完全就绪。 */
async function initializeNotesPath(): Promise<void> {
  if (store.getState().note.notesPath) return
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const info = await window.api.getAppInfo()
    if (info?.notesPath) {
      store.dispatch(setNotesPath(info.notesPath))
      logger.info('Initialized notes path on startup:', info.notesPath)
    }
  } catch (error) {
    logger.warn('Failed to initialize notes path on startup', error as Error)
  }
}

/** v0.3.0-2 目标 B：登记"上次会话留下的行"。
 *
 * 这是"内核不认识这一行"能否作为**失效**判据的唯一依据（见 `utils/topicBranch.ts` 的
 * `noteRestoredTopicIds`）：本进程内新建的话题在首发前内核本来就不认识它，不能据此判失效。
 * 记录时机是 rehydrate 这个**显式事件**，不是时间戳。
 *
 * 全新安装（从未写过持久化数据）不登记任何行：此时所有行都是本进程新建的，不存在"内核已遗忘"的判据。 */
async function recordRestoredTopicIds(): Promise<void> {
  try {
    const persisted = await storage.getItem('persist:cherry-studio')
    if (persisted === null) return
    noteRestoredTopicIds(
      store.getState().assistants.assistants.flatMap((assistant) => assistant.topics.map((topic) => topic.id))
    )
  } catch (error) {
    logger.warn('recordRestoredTopicIds failed', error instanceof Error ? error : new Error(String(error)))
  }
}

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
    // 已删除/迁移过滤的 provider → **不再删除** main 侧残留 key（v0.3.3-1 修复"更新后 key 消失"）：
    // 这份 redux 清单"是否已知完整"不可判定（localStorage 换 origin/清空、rehydrate 竞态、迁移分支
    // 丢字段都会让用户的 provider 暂时不在表里），而不变式 6 要求"不可判定的状态不做破坏性动作"。
    // 残留 key 无副作用；用户显式删 provider/清 key 时走 ProviderKeys_Remove，这里只如实记账。
    for (const [id] of entries) {
      if (!ids.has(id)) {
        logger.warn(`backfillProviderKeysFromVault: vault 含当前 provider 清单外的 key（${id}），保留不删`)
      }
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
