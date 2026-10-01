/**
 * 小窗（快捷助手 / mini window）的 store 角色：**只读 + 只收**。
 *
 * r2-03：`store/index.ts` 在模块顶层 `persistStore(store)`，而小窗是独立的 JS 上下文与独立的
 * Redux store，于是它也会建一个写同一个 `persist:cherry-studio` 键的 persistor。小窗里没有进
 * `syncList` 的切片（mcp / knowledge / websearch / shortcuts / minapps / preprocess / skills …）
 * 永远停在它启动时的快照，之后每收到一条同步来的 settings/llm 动作都触发整片写盘——把这些切片
 * 回写成旧值，主窗口后续的修改被静默回滚。同一 rehydrate 回调里的 `backfillProviderKeysFromVault`
 * 还会在小窗里 `dispatch(updateProviders(...))`（llm/ 前缀、无 `meta.fromSync`），被中间件从小窗
 * 广播回主窗口，用旧 provider 清单覆盖主窗口。
 *
 * 处理（保守，两端都不动 store/index.ts）：
 * ① `persistor.pause()`：只把 persistReducer 的 `_paused` 置真，`conditionalUpdate` 从此不再喂
 *    persistoid —— **读取不受影响**：rehydrate 照旧把主窗口写下的快照灌进小窗 store，
 *    `PersistGate` 的 bootstrapped 也照旧为真（它只依赖 REHYDRATE 动作）。小窗需要的状态
 *    （settings / llm / assistants / note）照旧来自"启动快照 + 同步通道"。
 * ② `setOptions({ syncList: [] })`：小窗**不再广播**任何动作（`shouldSyncAction` 恒 false），
 *    `subscribe()` 的**接收**方向不变。小窗内没有可写的同步切片（它只派发 messages/messageBlocks，
 *    两者都在 blacklist 且不在 syncList），所以广播方向本来就只有上面那条 rehydrate 回写；
 *    若将来小窗新增可写同步切片，必须改成定向同步，而不是恢复整片回写。
 *
 * 另一半（属 `store/index.ts`）：rehydrate 回调里的 `backfillProviderKeysFromVault()` /
 * `initializeNotesPath()` 应在非主窗口短路，且未同步切片的清单要在 store/index.ts 侧写清。
 */
import type { StoreSyncService } from '@renderer/services/StoreSyncService'
import type { Persistor } from 'redux-persist'

export function configureMiniWindowStoreRole(persistor: Persistor, storeSync: StoreSyncService): void {
  // ① 只读：本窗口不持有可写的 persistor（pause 不影响 rehydrate 读取与 PersistGate）。
  persistor.pause()
  // ② 只收：本窗口的切片是启动快照，回写会把主窗口的较新状态静默回滚。
  storeSync.setOptions({ syncList: [] })
}
