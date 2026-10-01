/**
 * r2-03 行为回归：小窗的 store 角色 —— 只读 + 只收。
 *
 * 驱动的是 `entryPoint.tsx` 调用的同一个函数 `configureMiniWindowStoreRole`，观察窗是
 * 「localStorage 里的 `persist:cherry-studio`」与「同步中间件发往其它窗口的广播」：
 * 应用角色**之前**，一次 settings 动作既写盘又广播；应用**之后**，同一个动作两者都不发生
 * （小窗的旧切片不会再把主窗口的较新状态静默回滚）。
 *
 * 第三段反向钉住"只读 ≠ 拿不到状态"：全新模块注册表起的第二个小窗实例，pause 之后
 * rehydrate 仍落地（`bootstrapped` 为真 ⇒ PersistGate 不卡死，主窗口的 settings 进得来）。
 *
 * 读写盘用 `persistor.flush()` 而非计时：暂停后 persistoid 没有待处理键，flush 不产生写入。
 */
import storeSyncService from '@renderer/services/StoreSyncService'
import store, { persistor } from '@renderer/store'
import { setTheme } from '@renderer/store/settings'
import { ThemeMode } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { configureMiniWindowStoreRole } from '../miniWindowStoreRole'

const PERSIST_KEY = 'persist:cherry-studio'

describe('mini 窗口 store 角色（r2-03）', () => {
  it('应用角色后：持久化切片不再回写 localStorage，也不再向其它窗口广播', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      storeSync: { onUpdate, subscribe: vi.fn().mockResolvedValue(undefined) }
    }
    // 与生产一致的"未应用小窗角色"基线：主窗口式配置（syncList 含 settings/）。
    storeSyncService.setOptions({ syncList: ['settings/'] })
    // bootstrapped 为真 ⇒ 本窗口 store 已收到 REHYDRATE（写盘前置条件成立）。
    await vi.waitFor(() => expect(persistor.getState().bootstrapped).toBe(true))

    store.dispatch(setTheme(ThemeMode.dark))
    await persistor.flush()
    const baseline = localStorage.getItem(PERSIST_KEY)
    // 基线非空转：这条动作确实写盘、确实广播。
    expect(baseline).toContain('dark')
    expect(onUpdate).toHaveBeenCalledTimes(1)

    configureMiniWindowStoreRole(persistor, storeSyncService)

    store.dispatch(setTheme(ThemeMode.light))
    await persistor.flush()
    expect(localStorage.getItem(PERSIST_KEY)).toBe(baseline)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // ③ 但"读"必须照旧：新起一个"小窗"实例（全新模块注册表）对着同一份快照，
    //    pause 之后 rehydrate 仍然落地 —— bootstrapped 为真 ⇒ PersistGate 不会卡死，
    //    主窗口写下的 settings 依然进得来（小窗不是"拿不到状态"）。
    vi.resetModules()
    const miniStore = (await import('@renderer/store')).default
    const miniPersistor = (await import('@renderer/store')).persistor
    const miniSync = (await import('@renderer/services/StoreSyncService')).default
    configureMiniWindowStoreRole(miniPersistor, miniSync)
    await vi.waitFor(() => expect(miniPersistor.getState().bootstrapped).toBe(true))
    expect(miniStore.getState().settings.theme).toBe(ThemeMode.dark)
  })
})
