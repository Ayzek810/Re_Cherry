/**
 * v0.3.2 批次3 自 CS_V1 移植 + 裁剪清单。
 *
 * CS_V1 的 MCPService 依赖全局 CacheService 做工具/提示词/资源列表的 TTL 缓存；
 * fork 无该服务，此处内置一个进程内最小 TTL 缓存（has/get/set/remove）替代，
 * 语义对齐 MCPService.withCache：命中即复用，过期或 remove 后重取。
 */
export class TTLCache {
  private store: Map<string, { value: unknown; expiresAt: number }> = new Map()

  /** 键存在且未过期时返回 true（惰性清理过期项）。 */
  has(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry) {
      return false
    }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key)
      return false
    }
    return true
  }

  /** 取缓存值；未命中或过期返回 undefined。 */
  get<T>(key: string): T | undefined {
    if (!this.has(key)) {
      return undefined
    }
    return this.store.get(key)?.value as T
  }

  /** 写入缓存；ttl 毫秒后过期。 */
  set(key: string, value: unknown, ttl: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttl })
  }

  /** 显式清除单个键（list_changed 通知 / 服务器关闭时调用）。 */
  remove(key: string): void {
    this.store.delete(key)
  }
}
