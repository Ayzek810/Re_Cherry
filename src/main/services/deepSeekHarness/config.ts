// fork 移植自 cherry-studio v2 src/main/services/deepSeekHarness/config.ts（2026-09-24，v0.3.4-1）。
// 锁机制 / YAML 事务 / 渲染逻辑逐字。缝点（均标注于行内）：
// ① 投影模型形状：V2 携带完整 Model 且由 projectModelInput/projectReasoningEfforts 现场投影；
//    fork 改为携带内核已投影的字段（KernelModelInput.input / reasoningEfforts 同形），两个
//    投影函数随之移除。代价：V2 的 reasoningEfforts:false（显式关闭）形态 fork 不产生
//    （内核 sanitizeReasoningEfforts 只在全正档位缺失时给 undefined）。
// ② resolveDeepSeekHarnessEndpoint：V2 按 Provider.endpointConfigs 多端点解析；fork provider
//    单 apiHost+type，协议映射复用内核 providers.ts 的 PROTOCOL_BY_TYPE（已导出共享）。
// ③ @shared/types/file 的 AbsoluteFilePath(Schema) 未移植——路径由本仓 paths.ts 构造，
//    退化为 string。

import crypto from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Document, isMap, isSeq, parseDocument, type YAMLError } from 'yaml'

import { PROTOCOL_BY_TYPE } from '@main/kernel/providers'
import { atomicWriteFile } from '@main/utils/atomicFile'
import type { DeepSeekHarnessAgentPreset } from '@shared/types/codeCli'
import { formatApiHost, withoutTrailingApiVersion } from '@shared/utils/api'

export type DeepSeekHarnessMode = 'direct' | 'gateway'
export type DeepSeekHarnessProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-completions'

/** fork 缝①：内核已投影的模型字段（代替 V2 的完整 Model）。 */
export interface DeepSeekHarnessModelProjection {
  name: string
  input: Array<'text' | 'image'>
  reasoningEfforts?: Record<string, string | null>
}

export interface DeepSeekHarnessProjection {
  route: string
  credentialRef: string
  credentialValue: string
  displayName: string
  protocol: DeepSeekHarnessProtocol
  baseUrl: string
  model: DeepSeekHarnessModelProjection
  modelId: string
  agentPreset: DeepSeekHarnessAgentPreset
}

interface FileSnapshot {
  path: string
  content?: string
}

export interface DeepSeekHarnessConfigReceipt {
  credentials: FileSnapshot & { written: string }
  settings: FileSnapshot & { written: string }
}

interface HeldLock {
  path: string
  handle: FileHandle
}

interface LockOwner {
  version: 1
  pid: number
  token: string
}

const SETTINGS_FILE = 'settings.yaml'
const CREDENTIALS_FILE = '.credentials.yaml'
const FILE_MODE = 0o600
const LOCK_TIMEOUT_MS = 2000
const LOCK_INITIAL_DELAY_MS = 20
const LOCK_MAX_DELAY_MS = 200

const MANAGED_CREDENTIAL_REF_RE = /^CHERRY_STUDIO_CODEMATE_(?:[A-F0-9]{12}|GATEWAY)_API_KEY$/i

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function parseLockOwner(content: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(content) as Partial<LockOwner>
    if (
      owner.version === 1 &&
      Number.isSafeInteger(owner.pid) &&
      Number(owner.pid) > 0 &&
      typeof owner.token === 'string' &&
      owner.token.length > 0
    ) {
      return owner as LockOwner
    }
  } catch {
    // Locks from DSH or older Cherry versions have no ownership metadata.
  }
  return undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function reclaimOrphanedLock(lockPath: string): Promise<boolean> {
  let observed: string
  try {
    observed = await fs.readFile(lockPath, 'utf8')
  } catch (error) {
    if (isMissing(error)) return true
    throw error
  }

  const owner = parseLockOwner(observed)
  if (!owner || isProcessAlive(owner.pid)) return false

  try {
    if ((await fs.readFile(lockPath, 'utf8')) !== observed) return false
    await fs.unlink(lockPath)
    return true
  } catch (error) {
    if (isMissing(error)) return true
    throw error
  }
}

async function createLock(lockPath: string): Promise<HeldLock> {
  const handle = await fs.open(lockPath, 'wx', FILE_MODE)
  try {
    const owner: LockOwner = { version: 1, pid: process.pid, token: crypto.randomUUID() }
    await handle.writeFile(JSON.stringify(owner), 'utf8')
    return { path: lockPath, handle }
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.unlink(lockPath).catch(() => {})
    throw error
  }
}

async function acquireLock(filePath: string): Promise<HeldLock> {
  const lockPath = `${filePath}.lock`
  const startedAt = Date.now()
  let backoff = LOCK_INITIAL_DELAY_MS

  while (true) {
    try {
      return await createLock(lockPath)
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      if (await reclaimOrphanedLock(lockPath)) continue
      const elapsed = Date.now() - startedAt
      if (elapsed >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for DeepSeek Harness config lock: ${path.basename(lockPath)}`)
      }
      await delay(Math.min(backoff, LOCK_TIMEOUT_MS - elapsed))
      backoff = Math.min(backoff * 2, LOCK_MAX_DELAY_MS)
    }
  }
}

async function acquireConfigLocks(credentialsPath: string, settingsPath: string): Promise<HeldLock[]> {
  const locks: HeldLock[] = []
  try {
    locks.push(await acquireLock(credentialsPath))
    locks.push(await acquireLock(settingsPath))
    return locks
  } catch (error) {
    await releaseLocks(locks)
    throw error
  }
}

async function releaseLocks(locks: HeldLock[]): Promise<void> {
  let releaseError: unknown
  for (const lock of [...locks].reverse()) {
    try {
      await lock.handle.close()
      await fs.unlink(lock.path)
    } catch (error) {
      releaseError ??= error
    }
  }
  if (releaseError) throw releaseError
}

async function readSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    return { path: filePath, content: await fs.readFile(filePath, 'utf8') }
  } catch (error) {
    if (isMissing(error)) return { path: filePath }
    throw error
  }
}

function parseMappingDocument(snapshot: FileSnapshot): Document {
  const document = snapshot.content === undefined ? new Document({}) : parseDocument(snapshot.content)
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid DeepSeek Harness YAML in ${path.basename(snapshot.path)}: ${describeYamlError(document.errors[0])}`
    )
  }
  if (document.contents === null) document.contents = document.createNode({})
  if (!isMap(document.contents)) {
    throw new Error(`DeepSeek Harness ${path.basename(snapshot.path)} must contain a YAML mapping`)
  }
  return document
}

function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0]
  const location = at ? ` at line ${at.line}, column ${at.col}` : ''
  return `${error.code}${location}`
}

// fork 缝①：projectModelInput / projectReasoningEfforts 移除——input 与 reasoningEfforts
// 由内核 providers.ts 的 sanitizeModelInput / sanitizeReasoningEfforts 预投影后经
// DeepSeekHarnessModelProjection 直达。

function updateManagedModel(document: Document, projection: DeepSeekHarnessProjection): void {
  const modelsPath = ['llm-pi-ai', 'providers', projection.route, 'models']
  if (!document.hasIn(modelsPath)) document.setIn(modelsPath, document.createNode([]))
  const models = document.getIn(modelsPath, true)
  if (!isSeq(models)) throw new Error(`DeepSeek Harness route ${projection.route} has a non-list models field`)

  let model = models.items.find((item) => isMap(item) && item.get('id') === projection.modelId)
  if (!model) {
    model = document.createNode({ id: projection.modelId })
    models.add(model)
  }
  if (!isMap(model)) throw new Error(`DeepSeek Harness route ${projection.route} contains an invalid model entry`)

  model.set('id', projection.modelId)
  model.set('name', projection.model.name || projection.modelId)
  model.set('input', projection.model.input)
  if (projection.model.reasoningEfforts === undefined) model.delete('reasoningEfforts')
  else model.set('reasoningEfforts', projection.model.reasoningEfforts)
}

function renderSettings(snapshot: FileSnapshot, projection: DeepSeekHarnessProjection): string {
  const document = parseMappingDocument(snapshot)
  const routePath = ['llm-pi-ai', 'providers', projection.route]
  if (document.hasIn(routePath)) {
    const credentialRef = document.getIn([...routePath, 'apiKeyEnv'])
    if (credentialRef !== projection.credentialRef) {
      throw new Error(`DeepSeek Harness route ${projection.route} is not owned by CodeMate`)
    }
  }

  document.setIn([...routePath, 'apiKeyEnv'], projection.credentialRef)
  document.setIn([...routePath, 'displayName'], projection.displayName)
  document.setIn([...routePath, 'api'], projection.protocol)
  document.setIn([...routePath, 'baseURL'], projection.baseUrl)
  document.deleteIn([...routePath, 'headers'])
  updateManagedModel(document, projection)
  document.setIn(['agent-default-model', 'provider'], projection.route)
  document.setIn(['agent-default-model', 'model'], projection.modelId)
  document.deleteIn(['agent-default-model', 'reasoningEffort'])
  if (projection.agentPreset !== 'inherit') {
    document.setIn(['agent-presets', 'default'], projection.agentPreset)
  }
  return document.toString()
}

function renderCredentials(snapshot: FileSnapshot, credentialRef: string, credentialValue: string): string {
  const document = parseMappingDocument(snapshot)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)) {
    throw new Error(`DeepSeek Harness credential reference ${JSON.stringify(credentialRef)} is invalid`)
  }
  // DSH 0.1.1 nests entries under `version: 1` + `refs:` and rejects unknown
  // top-level keys, including the one Cherry used to write there. Any other
  // document stays flat: pre-0.1.1 builds read it, and 0.1.1 migrates it itself.
  if (document.get('version') === 1) {
    if (document.getIn(['refs']) == null) document.setIn(['refs'], document.createNode({}))
    // Heal files polluted by older Cherry builds that wrote managed keys at
    // top-level: DSH 0.1.1 rejects any unknown top-level key, so every stale
    // CHERRY_STUDIO_CODEMATE_*_API_KEY entry must be removed, not just the
    // one for the current provider.
    if (isMap(document.contents)) {
      for (const pair of [...document.contents.items]) {
        const rawKey = (pair.key as { value?: unknown })?.value
        const key = typeof rawKey === 'string' ? rawKey : String(pair.key)
        if (MANAGED_CREDENTIAL_REF_RE.test(key)) document.delete(key)
      }
    }
    document.setIn(['refs', credentialRef], credentialValue)
  } else {
    document.setIn([credentialRef], credentialValue)
  }
  return document.toString()
}

async function restoreSnapshot(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    await fs.unlink(snapshot.path).catch((error) => {
      if (!isMissing(error)) throw error
    })
  } else {
    await atomicWriteFile(snapshot.path, snapshot.content, { mode: FILE_MODE })
  }
}

async function restoreSnapshots(settings: FileSnapshot, credentials: FileSnapshot): Promise<void> {
  const failures: unknown[] = []
  for (const snapshot of [settings, credentials]) {
    await restoreSnapshot(snapshot).catch((error) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Failed to restore DeepSeek Harness config files')
}

function sameSnapshotContent(snapshot: FileSnapshot, expected: string): boolean {
  return snapshot.content === expected
}

// fork 缝②：V2 版按 Provider.endpointConfigs/model.endpointTypes 多端点解析；fork 的
// provider 是单 apiHost+type，协议映射直接复用内核 providers.ts 的 PROTOCOL_BY_TYPE。
// baseURL 规则与 V2 相同：anthropic 协议剥掉尾部 /v1（DSH 的 anthropic-messages 自带版本路径）。
export function resolveDeepSeekHarnessEndpoint(provider: {
  id: string
  type: string
  apiHost?: string
}): { protocol: DeepSeekHarnessProtocol; baseUrl: string } {
  const protocol = PROTOCOL_BY_TYPE[provider.type] as DeepSeekHarnessProtocol | undefined
  if (!protocol) {
    throw new Error(`Provider ${provider.id} (type ${provider.type}) has no DeepSeek Harness compatible endpoint`)
  }
  if (!provider.apiHost) throw new Error(`Provider ${provider.id} has no API host configured`)
  const baseUrl =
    protocol === 'anthropic-messages'
      ? withoutTrailingApiVersion(formatApiHost(provider.apiHost, false))
      : formatApiHost(provider.apiHost)
  return { protocol, baseUrl }
}

export function createDeepSeekHarnessDirectIdentity(
  providerId: string,
  protocol: DeepSeekHarnessProtocol
): {
  route: string
  credentialRef: string
} {
  const hash = crypto.createHash('sha256').update(`${providerId}\0${protocol}`).digest('hex').slice(0, 12)
  return {
    route: `cherry-studio-codemate-${hash}`,
    credentialRef: `CHERRY_STUDIO_CODEMATE_${hash.toUpperCase()}_API_KEY`
  }
}

export async function writeDeepSeekHarnessConfig(
  configDir: string,
  projection: DeepSeekHarnessProjection
): Promise<DeepSeekHarnessConfigReceipt> {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 })
  const credentialsPath = path.join(configDir, CREDENTIALS_FILE)
  const settingsPath = path.join(configDir, SETTINGS_FILE)
  const locks = await acquireConfigLocks(credentialsPath, settingsPath)

  try {
    const credentials = await readSnapshot(credentialsPath)
    const settings = await readSnapshot(settingsPath)
    const writtenCredentials = renderCredentials(credentials, projection.credentialRef, projection.credentialValue)
    const writtenSettings = renderSettings(settings, projection)

    try {
      await atomicWriteFile(credentialsPath, writtenCredentials, { mode: FILE_MODE })
      await atomicWriteFile(settingsPath, writtenSettings, { mode: FILE_MODE })
    } catch (error) {
      try {
        await restoreSnapshots(settings, credentials)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Failed to roll back DeepSeek Harness config transaction')
      }
      throw error
    }

    return {
      credentials: { ...credentials, written: writtenCredentials },
      settings: { ...settings, written: writtenSettings }
    }
  } finally {
    await releaseLocks(locks)
  }
}

export async function rollbackDeepSeekHarnessConfig(receipt: DeepSeekHarnessConfigReceipt): Promise<boolean> {
  const locks = await acquireConfigLocks(receipt.credentials.path, receipt.settings.path)
  try {
    const currentCredentials = await readSnapshot(receipt.credentials.path)
    const currentSettings = await readSnapshot(receipt.settings.path)
    if (
      !sameSnapshotContent(currentCredentials, receipt.credentials.written) ||
      !sameSnapshotContent(currentSettings, receipt.settings.written)
    ) {
      return false
    }
    await restoreSnapshots(receipt.settings, receipt.credentials)
    return true
  } finally {
    await releaseLocks(locks)
  }
}
