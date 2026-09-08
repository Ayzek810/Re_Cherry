/**
 * Provider API key 加密存储（K1）。
 *
 * key 的持久化真源从 renderer localStorage 挪到 main：用 electron-store（独立文件 provider-keys.json）
 * 落盘 safeStorage 加密后的密文（base64），renderer 不再持久化明文（K3 从 persist 剥离，K4 启动回填）。
 *
 * 按 v0.2.4 定稿：不为 safeStorage 不可用写降级明文机制（用户裁决，无老用户）；
 * Linux basic_text 后端由 OS 决定，代码只调 encryptString/decryptString。
 */
import { safeStorage } from 'electron'
import Store from 'electron-store'

interface ProviderKeyStoreShape {
  /** providerId -> base64(safeStorage.encryptString(apiKey)) */
  keys?: Record<string, string>
}

export class ProviderKeyStore {
  private readonly store: Store<ProviderKeyStoreShape>

  constructor() {
    this.store = new Store<ProviderKeyStoreShape>({
      name: 'provider-keys',
      defaults: { keys: {} }
    })
  }

  private encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64')
  }

  private decrypt(encoded: string): string {
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      // 解密失败（例如换了系统用户/钥匙串丢失）→ 该 key 视为不存在，不抛错污染启动
      return ''
    }
  }

  get(providerId: string): string | undefined {
    const encoded = this.store.get('keys')?.[providerId]
    if (!encoded) return undefined
    const plain = this.decrypt(encoded)
    return plain.length > 0 ? plain : undefined
  }

  /** 返回全部 providerId -> 明文 key（启动回填 K4 用）。 */
  getAll(): Record<string, string> {
    const result: Record<string, string> = {}
    const keys = this.store.get('keys') ?? {}
    for (const [id, encoded] of Object.entries(keys)) {
      const plain = this.decrypt(encoded)
      if (plain.length > 0) result[id] = plain
    }
    return result
  }

  set(providerId: string, apiKey: string): void {
    if (apiKey.length === 0) return
    this.store.set('keys', { ...this.store.get('keys'), [providerId]: this.encrypt(apiKey) })
  }

  /** 批量写入（provider 同步时整体覆盖）。 */
  setMany(entries: Record<string, string>): void {
    const next: Record<string, string> = {}
    for (const [id, key] of Object.entries(entries)) {
      if (key.length > 0) next[id] = this.encrypt(key)
    }
    this.store.set('keys', next)
  }

  remove(providerId: string): void {
    const keys = { ...this.store.get('keys') }
    delete keys[providerId]
    this.store.set('keys', keys)
  }

  /** 是否已配置（供 renderer 显示“已设置密钥”占位，不解密）。 */
  has(providerId: string): boolean {
    return Boolean(this.store.get('keys')?.[providerId])
  }
}

export const providerKeyStore = new ProviderKeyStore()
