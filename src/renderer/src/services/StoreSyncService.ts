import { loggerService } from '@logger'
import type { Middleware } from '@reduxjs/toolkit'
import type { StoreSyncAction } from '@types'

const logger = loggerService.withContext('StoreSyncService')

type SyncOptions = {
  syncList: string[]
}

/**
 * StoreSyncService class manages Redux store synchronization between multiple windows
 * It uses singleton pattern to ensure only one sync service instance exists in the application
 *
 * Main features:
 * 1. Synchronizes Redux actions between windows via IPC
 * 2. Provides Redux middleware to intercept and broadcast actions that need syncing
 * 3. Supports whitelist configuration for action types to sync
 * 4. Handles window subscription and unsubscription logic
 */
export class StoreSyncService {
  private static instance: StoreSyncService
  private options: SyncOptions = {
    syncList: []
  }
  private broadcastSyncRemover: (() => void) | null = null
  /**
   * `beforeunload` 处理器（v1 二轮性能审计 p2-14）。必须有稳定引用，`unsubscribe()`
   * 才能 `removeEventListener` 摘掉它；否则每次 `subscribe()` 都会多挂一个监听器，
   * 旧的还一直持有本 service 引用。
   */
  private readonly beforeUnloadHandler = (): void => {
    this.unsubscribe()
  }

  private constructor() {
    return
  }

  /**
   * Get the singleton instance of StoreSyncService
   */
  public static getInstance(): StoreSyncService {
    if (!StoreSyncService.instance) {
      StoreSyncService.instance = new StoreSyncService()
    }
    return StoreSyncService.instance
  }

  /**
   * Set sync options
   * @param options Partial sync options
   */
  public setOptions(options: Partial<SyncOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /**
   * Create Redux middleware to intercept and broadcast actions
   * Actions will not be broadcasted if they are not in whitelist or come from sync
   */
  public createMiddleware(): Middleware {
    return () => (next) => (action) => {
      // Process the action normally first
      const result = next(action)

      // Check if this action came from sync or is a whitelisted action
      const syncAction = action as StoreSyncAction
      if (!syncAction.meta?.fromSync && this.shouldSyncAction(syncAction.type)) {
        // Send to main process for broadcasting to other windows using the preload API
        if (window.api?.storeSync) {
          void window.api.storeSync.onUpdate(syncAction)
        }
      }

      return result
    }
  }

  /**
   * Check if action type is in whitelist
   * @param actionType Action type to check
   * @returns Whether the action should be synced
   */
  private shouldSyncAction(actionType: string): boolean {
    // If no whitelist is specified, sync nothing
    if (!this.options.syncList.length) {
      return false
    }

    // Check if the action belongs to a store slice we want to sync
    return this.options.syncList.some((prefix) => {
      return actionType.startsWith(prefix)
    })
  }

  /**
   * Subscribe to sync service
   * Sets up IPC listener and registers cleanup on window close
   */
  public subscribe(): void {
    // 幂等入口（v1 二轮性能审计 p2-14）：重复 subscribe 前先摘干净上一轮，
    // 否则每次都会多挂一个 beforeunload 监听器。
    this.unsubscribe()

    if (!window.api?.storeSync) {
      return
    }

    this.broadcastSyncRemover = window.api.events.onStoreSyncBroadcast((action) => {
      try {
        // Dispatch to the store
        if (window.store) {
          window.store.dispatch(action as StoreSyncAction)
        }
      } catch (error) {
        logger.error('Error dispatching synced action:', error as Error)
      }
    })

    void window.api.storeSync.subscribe()

    // p2-14：handler 存成实例字段，`unsubscribe()` 才能摘掉它。此前传的是匿名箭头函数，
    // 无引用留存 ⇒ `unsubscribe()` 只摘 IPC remover，`beforeunload` 监听器永久累积
    // （每次重新 subscribe 多一个，且旧的仍持有本 service 引用）。
    window.addEventListener('beforeunload', this.beforeUnloadHandler)
  }

  /**
   * Unsubscribe from sync service
   * Cleans up IPC listener and related resources
   */
  public unsubscribe(): void {
    if (window.api?.storeSync) {
      void window.api.storeSync.unsubscribe()
    }

    if (this.broadcastSyncRemover) {
      this.broadcastSyncRemover()
      this.broadcastSyncRemover = null
    }

    window.removeEventListener('beforeunload', this.beforeUnloadHandler)
  }
}

// Export singleton instance
export default StoreSyncService.getInstance()
