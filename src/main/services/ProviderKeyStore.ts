/**
 * Provider API key 加密存储（K1）。
 *
 * key 的持久化真源从 renderer localStorage 挪到 main：用 electron-store（独立文件 provider-keys.json）
 * 落盘 safeStorage 加密后的密文（base64），renderer 不再持久化明文（K3 从 persist 剥离，K4 启动回填）。
 *
 * 按 v0.2.4 定稿：不为 safeStorage 不可用写降级明文机制（用户裁决，无老用户）；
 * Linux basic_text 后端由 OS 决定，代码只调 encryptString/decryptString。
 *
 * **v0.3.3-1 修复（"更新后 key 消失要重填"）**：electron-store 在**构造时**取
 * `app.getPath('userData')` 当 cwd，而打包产物把本模块切进共享 chunk、由入口在最前面 require
 * —— 于是单例构造发生在 `initAppDataDir()`（把 userData 重定向到用户配置的目录）**之前**，
 * key 文件因此长期落在 Electron 默认目录（`%APPDATA%\Re_Cherry`），与应用其余数据（Chromium 档案、
 * 内核库、`Data/`）分居两地；构建的 chunk 切分一变，读的就是另一个文件 ⇒ 表现为"更新后 key 没了"。
 * 两道处置：
 *   ① Store **懒构造**（首次真正读写时才 new，此时重定向早已生效）；
 *   ② 首次读写时做一次**非破坏性合并**：从其它候选位置（Electron 默认目录 + `~/.re_cherry/config`
 *      里登记过的 dataPath）把本文件缺失的 providerId 密文补进来，并让**文件更新的那份赢**（用户可能
 *      在任一侧重填过 key）；只增不删。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { HOME_CHERRY_DIR } from '@shared/config/constant'
import { app, safeStorage } from 'electron'
import Store from 'electron-store'

const logger = loggerService.withContext('ProviderKeyStore')

interface ProviderKeyStoreShape {
  /** providerId -> base64(safeStorage.encryptString(apiKey)) */
  keys?: Record<string, string>
}

const VAULT_FILE_NAME = 'provider-keys.json'

/** 解析 vault 文件内容（形状 `{ keys: { id: base64 } }`）；坏 JSON/坏形状 → 空表。纯函数，便于单测。 */
export function parseVaultKeys(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as ProviderKeyStoreShape
    const keys = parsed?.keys
    if (keys === null || typeof keys !== 'object') return {}
    return Object.fromEntries(
      Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.length > 0)
    )
  } catch {
    return {}
  }
}

/** 读一个 vault 文件的原始密文表；不存在/读不了 → 空表。 */
export function readVaultKeys(filePath: string): Record<string, string> {
  try {
    return parseVaultKeys(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return {}
  }
}

export interface VaultSnapshot {
  path: string
  keys: Record<string, string>
  /** 文件 mtime（毫秒）；-1 = 文件不存在/读不到。 */
  mtimeMs: number
}

/**
 * 多份 vault 的合并口径（**不删任何条目**）：
 * - 本表缺失的 providerId → 补进来（多份候选之间，新的后写，故新的赢）；
 * - 两边都有 → **文件更新的那份赢**（用户可能在任一侧重填过 key，不能拿旧密文盖掉新的）；
 * - 谁都不会被删除。
 */
export function mergeVaults(
  ours: VaultSnapshot,
  candidates: VaultSnapshot[]
): { keys: Record<string, string>; added: string[]; updated: string[]; usedFrom: string[] } {
  const keys = { ...ours.keys }
  const ordered = [...candidates].filter((c) => c.mtimeMs >= 0).sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const candidate of ordered) {
    const candidateIsNewer = candidate.mtimeMs > ours.mtimeMs
    for (const [id, encoded] of Object.entries(candidate.keys)) {
      if (encoded.length === 0) continue
      const existing = keys[id]
      if (existing === undefined || existing.length === 0) {
        keys[id] = encoded
        continue
      }
      if (candidateIsNewer && existing !== encoded) keys[id] = encoded
    }
  }
  const hasOurs = (id: string): boolean => (ours.keys[id]?.length ?? 0) > 0
  const added = Object.keys(keys).filter((id) => keys[id].length > 0 && !hasOurs(id))
  const updated = Object.keys(keys).filter((id) => hasOurs(id) && ours.keys[id] !== keys[id])
  const usedFrom = ordered
    .filter((candidate) =>
      Object.entries(candidate.keys).some(
        ([id, encoded]) => encoded.length > 0 && keys[id] === encoded && ours.keys[id] !== encoded
      )
    )
    .map((candidate) => candidate.path)
  return { keys, added, updated, usedFrom: [...new Set(usedFrom)] }
}

/** 文件 mtime（毫秒）；不存在/读不到 → -1。 */
function statMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return -1
  }
}

/** 读一个 vault 快照（内容 + mtime）；不存在/读不到 → 空表 + mtime -1。 */
export function readVaultSnapshot(filePath: string): VaultSnapshot {
  return { path: filePath, keys: readVaultKeys(filePath), mtimeMs: statMtime(filePath) }
}

/**
 * 从 `~/.re_cherry/config/config.json` 的内容里取出登记过的 dataPath（兼容旧版 `appDataPath` 为字符串的形态）。
 * 纯函数；空表/坏 JSON 都返回空数组。
 */
export function vaultPathsFromConfig(configRaw: string, currentPath: string): string[] {
  try {
    const config = JSON.parse(configRaw) as { appDataPath?: string | Array<{ dataPath?: string }> }
    const entries = Array.isArray(config.appDataPath) ? config.appDataPath : [{ dataPath: config.appDataPath }]
    const paths = new Set<string>()
    for (const entry of entries) {
      const dataPath = typeof entry?.dataPath === 'string' ? entry.dataPath : ''
      if (dataPath.length === 0) continue
      const candidate = path.join(dataPath, VAULT_FILE_NAME)
      if (candidate !== currentPath) paths.add(candidate)
    }
    return [...paths]
  } catch {
    return []
  }
}

/** 除本文件之外，可能存有同一份 key 的候选 vault 路径（Electron 默认目录 + 登记过的 dataPath）。 */
export function candidateVaultPaths(currentPath: string): string[] {
  const candidates = new Set<string>()
  try {
    candidates.add(path.join(app.getPath('appData'), app.getName(), VAULT_FILE_NAME))
  } catch {
    // app 未就绪等：忽略
  }
  try {
    const configPath = path.join(os.homedir(), HOME_CHERRY_DIR, 'config', 'config.json')
    for (const candidate of vaultPathsFromConfig(fs.readFileSync(configPath, 'utf-8'), currentPath)) {
      candidates.add(candidate)
    }
  } catch {
    // 没有配置文件就是没有候选
  }
  candidates.delete(currentPath)
  return [...candidates]
}

export class ProviderKeyStore {
  private storeInstance?: Store<ProviderKeyStoreShape>
  private recoveryDone = false

  /** 懒构造：路径在**首次使用**时才解析（此时 `initAppDataDir()` 的重定向已经生效）。 */
  private get store(): Store<ProviderKeyStoreShape> {
    if (this.storeInstance === undefined) {
      this.storeInstance = new Store<ProviderKeyStoreShape>({ name: 'provider-keys', defaults: { keys: {} } })
      this.recoverFromOtherVaults()
    }
    return this.storeInstance
  }

  /** 本 vault 的实际文件路径（诊断/备份用；同样会触发懒构造）。 */
  get path(): string {
    return this.store.path
  }

  /**
   * 非破坏性补齐：把**其它候选位置**里的 providerId 合并进本文件——本表缺的补进来，两边都有则
   * 文件更新的那份赢（用户可能在任一侧重填过 key）。只增不删，任何异常都不影响启动
   * （key 缺失是"未配置"，不是崩溃理由）。
   */
  private recoverFromOtherVaults(): void {
    if (this.recoveryDone) return
    this.recoveryDone = true
    try {
      const store = this.storeInstance
      if (store === undefined) return
      const ours: VaultSnapshot = {
        path: store.path,
        keys: store.get('keys') ?? {},
        mtimeMs: statMtime(store.path)
      }
      const candidates = candidateVaultPaths(store.path).map((candidate) => readVaultSnapshot(candidate))
      const { keys, added, updated, usedFrom } = mergeVaults(ours, candidates)
      if (added.length === 0 && updated.length === 0) return
      store.set('keys', keys)
      // 用 warn 级：renderer/info 级日志不落盘（经验教训 §4.43），而这条是真机取证要看的状态变更。
      logger.warn(
        `providerKeyStore: merged keys from ${usedFrom.join(', ')} -> ${ours.path} (added ${added.length}, updated ${updated.length})`
      )
    } catch (error) {
      logger.warn('providerKeyStore: recovery skipped', error instanceof Error ? error : new Error(String(error)))
    }
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
