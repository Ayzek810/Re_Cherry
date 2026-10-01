import { allMinApps } from '@renderer/config/minapps'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings' // 使用设置中的值
import NavigationService from '@renderer/services/NavigationService'
import TabsService from '@renderer/services/TabsService'
import { useAppDispatch } from '@renderer/store'
import {
  setCurrentMinappId,
  setMinappShow,
  setOpenedKeepAliveMinapps,
  setOpenedOneOffMinapp
} from '@renderer/store/runtime'
import type { MinAppType } from '@renderer/types'
import { clearWebviewState } from '@renderer/utils/webviewStateManager'
import { LRUCache } from 'lru-cache'
import { useCallback, useEffect, useState } from 'react'

import { useNavbarPosition } from './useSettings'

let minAppsCache: LRUCache<string, MinAppType>

/**
 * Usage:
 *
 *   To control the minapp popup, you can use the following hooks:
 *     import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
 *
 *   in the component:
 *     const { openMinapp, openMinappKeepAlive, openMinappById,
 *             closeMinapp, hideMinappPopup, closeAllMinapps } = useMinappPopup()
 *
 *   To use some key states of the minapp popup:
 *     import { useRuntime } from '@renderer/hooks/useRuntime'
 *     const { openedKeepAliveMinapps, openedOneOffMinapp, minappShow } = useRuntime()
 */
export const useMinappPopup = () => {
  const dispatch = useAppDispatch()
  const { openedKeepAliveMinapps, openedOneOffMinapp, minappShow } = useRuntime()
  const { maxKeepAliveMinapps } = useSettings() // 使用设置中的值
  const { isTopNavbar } = useNavbarPosition()

  const createLRUCache = useCallback(() => {
    return new LRUCache<string, MinAppType>({
      max: maxKeepAliveMinapps ?? 10,
      disposeAfter: (_value, key) => {
        // Clean up WebView state when app is disposed from cache
        clearWebviewState(key)

        // Close corresponding tab if it exists
        const tabs = TabsService.getTabs()
        const tabToClose = tabs.find((tab) => tab.path === `/apps/${key}`)
        if (tabToClose) {
          TabsService.closeTab(tabToClose.id)
        }

        // Update Redux state
        dispatch(setOpenedKeepAliveMinapps(Array.from(minAppsCache.values())))
      },
      onInsert: () => {
        dispatch(setOpenedKeepAliveMinapps(Array.from(minAppsCache.values())))
      },
      updateAgeOnGet: true,
      updateAgeOnHas: true
    })
  }, [dispatch, maxKeepAliveMinapps])

  // 缓存不存在：渲染期只创建**空**缓存 —— LRU 的 `onInsert`/`disposeAfter` 只在写入/淘汰
  // 时触发，空构造不 dispatch，故这里没有「渲染期更新 store」。模块级单例是刻意的
  // （多个组件共享同一缓存；改成 per-instance ref 会让 `closeAllMinapps` 只换掉一个实例）。
  if (!minAppsCache) {
    minAppsCache = createLRUCache()
  }

  /**
   * 容量变化后的重建从渲染期移入 effect。重建会用 `set()` 回填旧条目，LRU 的
   * `onInsert` 会同步 `dispatch(setOpenedKeepAliveMinapps(...))`（`disposeAfter` 还会
   * `dispatch` + `TabsService.closeTab`）—— 那是「渲染另一个组件时更新 store」的非法副作用
   * （React 可能丢弃或重复执行该渲染）。`lru-cache@11` 的 `max` 是只读 getter，改容量只能
   * 新建实例，所以重建仍保留；同时用一次强制渲染把重建后的实例交回消费方
   * （否则本次渲染返回的引用与重建后的单例不是同一个）。
   */
  const [, bumpCacheVersion] = useState(0)

  useEffect(() => {
    if (minAppsCache.max !== maxKeepAliveMinapps) {
      // 1. 当前小程序数量小于等于设置的缓存数量，直接重新建立缓存
      if (minAppsCache.size <= maxKeepAliveMinapps) {
        // LRU cache 机制，后 set 的会被放到前面，所以需要反转一下
        const oldEntries = Array.from(minAppsCache.entries()).reverse()
        minAppsCache = createLRUCache()
        oldEntries.forEach(([key, value]) => {
          minAppsCache.set(key, value)
        })
        // 让消费方重新渲染并拿到重建后的实例（dispatch 已在 effect 中完成）
        bumpCacheVersion((version) => version + 1)
      }
      // 2. 大于设置的缓存的话，就直到数量减少到设置的缓存数量
    }
  }, [createLRUCache, maxKeepAliveMinapps])

  /** Open a minapp (popup shows and minapp loaded) */
  const openMinapp = useCallback(
    (app: MinAppType, keepAlive: boolean = false) => {
      if (keepAlive) {
        // 通过 get 和 set 去更新缓存，避免重复添加
        const cacheApp = minAppsCache.get(app.id)
        if (!cacheApp) minAppsCache.set(app.id, app)

        // 如果小程序已经打开，只切换显示
        if (openedKeepAliveMinapps.some((item) => item.id === app.id)) {
          dispatch(setCurrentMinappId(app.id))
          dispatch(setMinappShow(true))
          return
        }
        dispatch(setOpenedOneOffMinapp(null))
        dispatch(setCurrentMinappId(app.id))
        dispatch(setMinappShow(true))
        return
      }

      //if the minapp is not keep alive, open it as one-off minapp
      dispatch(setOpenedOneOffMinapp(app))
      dispatch(setCurrentMinappId(app.id))
      dispatch(setMinappShow(true))
      return
    },
    [dispatch, openedKeepAliveMinapps]
  )

  /** a wrapper of openMinapp(app, true) */
  const openMinappKeepAlive = useCallback(
    (app: MinAppType) => {
      openMinapp(app, true)
    },
    [openMinapp]
  )

  /** Open a minapp by id (look up the minapp in allMinApps) */
  const openMinappById = useCallback(
    (id: string, keepAlive: boolean = false) => {
      const app = allMinApps.find((app) => app?.id === id)
      if (app) {
        openMinapp(app, keepAlive)
      }
    },
    [openMinapp]
  )

  /** Close a minapp immediately (popup hides and minapp unloaded) */
  const closeMinapp = useCallback(
    (appid: string) => {
      if (openedKeepAliveMinapps.some((item) => item.id === appid)) {
        minAppsCache.delete(appid)
      } else if (openedOneOffMinapp?.id === appid) {
        dispatch(setOpenedOneOffMinapp(null))
      }

      dispatch(setCurrentMinappId(''))
      dispatch(setMinappShow(false))
      return
    },
    [dispatch, openedKeepAliveMinapps, openedOneOffMinapp]
  )

  /** Close all minapps (popup hides and all minapps unloaded) */
  const closeAllMinapps = useCallback(() => {
    // minAppsCache.clear 会多次调用 dispose 方法
    // 重新创建一个 LRU Cache 替换
    minAppsCache = createLRUCache()
    dispatch(setOpenedKeepAliveMinapps([]))
    dispatch(setOpenedOneOffMinapp(null))
    dispatch(setCurrentMinappId(''))
    dispatch(setMinappShow(false))
  }, [dispatch, createLRUCache])

  /** Hide the minapp popup (only one-off minapp unloaded) */
  const hideMinappPopup = useCallback(() => {
    if (!minappShow) return

    if (openedOneOffMinapp) {
      dispatch(setOpenedOneOffMinapp(null))
      dispatch(setCurrentMinappId(''))
    }
    dispatch(setMinappShow(false))
  }, [dispatch, minappShow, openedOneOffMinapp])

  /** Smart open minapp that adapts to navbar position */
  const openSmartMinapp = useCallback(
    (config: MinAppType, keepAlive: boolean = false) => {
      if (isTopNavbar) {
        // For top navbar mode, need to add to cache first for temporary apps
        const cacheApp = minAppsCache.get(config.id)
        if (!cacheApp) {
          // Add temporary app to cache so MinAppPage can find it
          minAppsCache.set(config.id, config)
        }

        // Set current minapp and show state
        dispatch(setCurrentMinappId(config.id))
        dispatch(setMinappShow(true))

        // Then navigate to the app tab using NavigationService
        if (NavigationService.navigate) {
          NavigationService.navigate(`/apps/${config.id}`)
        }
      } else {
        // For side navbar, use the traditional popup system
        openMinapp(config, keepAlive)
      }
    },
    [isTopNavbar, openMinapp, dispatch]
  )

  return {
    openMinapp,
    openMinappKeepAlive,
    openMinappById,
    closeMinapp,
    hideMinappPopup,
    closeAllMinapps,
    openSmartMinapp,
    // Expose cache instance for TabsService integration
    minAppsCache
  }
}
