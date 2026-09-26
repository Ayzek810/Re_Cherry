// fork 缝（原创）：V2 为 mise 驱动，本件为 portable 等价实现——快照/操作状态机/mutex 串行/
// availability 广播的形状照抄 V2 src/main/services/binaryManager/BinaryManager.ts，mise 命令
// 面全部替换为 npm --prefix / python venv + pip（设计来源：V2 BinaryManager + pythonRuntime，
// 勾勒自勘查报告结论，docs/v0.3.4_doc.md）。一切钉在 {userData}/Data/CodeMate/ 子树：不改
// 系统 PATH、不写用户全局配置，卸载 = 删子树。BinaryToolSnapshot 为 V2
// src/shared/types/binary.ts 的子集抄形状（fork 不建 shared 文件，operation/definition 面若
// UI 需要随批次4 再补）。

import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { Mutex } from 'async-mutex'
import { BrowserWindow } from 'electron'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { probeBinary, probeSystemPath } from '@main/services/codeCli/resolveBinary'
import { cacheRoot, codeMateRuntimeRoot, codeMateToolsRoot, deepSeekHarnessHome } from '@main/services/deepSeekHarness/paths'
import { crossPlatformSpawn } from '@main/utils/processRunner'
import { withPathPrepend } from '@main/utils/shellEnv'
import { removeTreeWithRetry } from './removeTree'
import { IpcChannel } from '@shared/IpcChannel'
import { redactSecretText } from '@shared/utils/redaction'

import { type BinaryToolName, type BinaryToolPreset, BINARY_TOOL_PRESETS } from './presets'
import {
  ensureNodeRuntime,
  ensurePythonRuntime,
  isNodeRuntimeInstalled
} from './runtimeDownloader'

const logger = loggerService.withContext('BinaryManager')

// v0.3.4-2：快照 stale-while-revalidate 的缓存文件与后台重探冷却。
const SNAPSHOT_CACHE_FILENAME = 'snapshot-cache.json'
const SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000

// V2 快照/操作超时预算的等价裁剪：安装是分钟级（V2 MISE_INSTALL_TIMEOUT_MS 同量级），
// 查询是秒级。
const INSTALL_TIMEOUT_MS = 15 * 60_000
const NPM_VIEW_TIMEOUT_MS = 15_000
const PYPI_TIMEOUT_MS = 10_000
const OUTPUT_TAIL_LIMIT = 16 * 1024

// fork 缝：registry 固定走 npmmirror（V2 走用户代理/区域策略 + mise 内部解析；portable
// 安装器为可预期行为写死镜像）。pip 源 official 在前、清华镜像在后（pip 按序尝试）——
// 与 V2 的清华镜像策略对应（V2 另有腾讯镜像背书，fork 裁为单镜像）。
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'
// v0.3.4-2（用户裁决）：dsh 通道锚 npm 的 `next` dist-tag——社区的当前代际发在 next
// （0.1.7-rc.2），`latest` 停在 0.1.5-rc.3 不动；锚 latest 就永远收不到新一代（真机
// 取证：用户对比社区桌面壳发现"已经到 0.17 而这里还是 0.15 且没有推送更新"）。
// 安装与更新检查共用此 tag，语义恒对齐。
const DSH_NPM_DIST_TAG = 'next'
const PYPI_OFFICIAL_INDEX = 'https://pypi.org/simple'
const PYPI_TSINGHUA_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'

const TOOL_VERSION_MARKER = '.codemate-version'

// ---------------------------------------------------------------------------
// 类型：V2 src/shared/types/binary.ts 子集抄形状
// ---------------------------------------------------------------------------

export type BinaryApplicationStatus = 'applied' | 'broken' | 'absent'

export type BinaryAvailability =
  | { source: 'managed'; path: string; version?: string }
  | { source: 'system'; path: string }
  | { source: 'none' }

export type BinaryToolSnapshot = {
  name: string
  application: BinaryApplicationStatus
  availability: BinaryAvailability
}

export type BinaryOperationResult = { success: true } | { success: false; message: string }

export type BinaryRemoveResult = { removed: boolean; message?: string }

// ---------------------------------------------------------------------------
// 工具计划：shared 预设 → fork 安装后端（install: 'npm' → npm --prefix；'pipx' → venv）
// ---------------------------------------------------------------------------

interface ToolPlan {
  name: string
  preset: BinaryToolPreset
  kind: 'npm' | 'venv'
  /** 1:1 运行时映射（node↔dsh、python↔hermes；fork 缝：写死，V2 由 mise 统一管理）。 */
  runtime: 'node' | 'python'
}

function toToolPlan(preset: BinaryToolPreset): ToolPlan | undefined {
  switch (preset.install) {
    case 'npm':
      return { name: preset.executable, preset, kind: 'npm', runtime: 'node' }
    case 'pipx':
      return { name: preset.executable, preset, kind: 'venv', runtime: 'python' }
    default:
      logger.warn(`Managed installer does not support backend "${preset.install}" for tool ${preset.executable}`)
      return undefined
  }
}

const TOOL_PLANS: ReadonlyMap<string, ToolPlan> = new Map(
  BINARY_TOOL_PRESETS.map((preset) => [preset.executable, toToolPlan(preset)]).filter(
    (entry): entry is [string, ToolPlan] => entry[1] !== undefined
  )
)

// V2 BinaryManager.ts 的 MISE_REQUIRED_PEERS 等价物：键从 miseTool 换成 executable。
const REQUIRED_PEERS: ReadonlyMap<string, { host: string; peer: string }> = new Map(
  BINARY_TOOL_PRESETS.flatMap((preset) =>
    preset.requiredPeer ? [[preset.executable, preset.requiredPeer] as const] : []
  )
)

function toolDir(name: string): string {
  return path.join(codeMateToolsRoot(), name)
}

/** 受管可执行文件的落点（resolveBinary.ts 的受管探测映射与本函数保持一致）。 */
function managedBinaryPath(plan: ToolPlan): string {
  if (plan.kind === 'npm') {
    // npm 型：bin shim 在 node_modules/.bin（Windows 为 .cmd）。
    return path.join(
      toolDir(plan.name),
      'node_modules',
      '.bin',
      isWin ? `${plan.preset.executable}.cmd` : plan.preset.executable
    )
  }
  // venv 型：Windows 在 Scripts/，Unix 在 bin/。
  return isWin
    ? path.join(toolDir(plan.name), 'Scripts', `${plan.preset.executable}.exe`)
    : path.join(toolDir(plan.name), 'bin', plan.preset.executable)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function readToolVersionMarker(name: string): Promise<string | undefined> {
  try {
    return (await fsp.readFile(path.join(toolDir(name), TOOL_VERSION_MARKER), 'utf-8')).trim() || undefined
  } catch {
    return undefined
  }
}

async function listDirForDiagnostics(dir: string): Promise<string> {
  try {
    return (await fsp.readdir(dir)).join(', ') || '(empty)'
  } catch {
    return '(unreadable)'
  }
}

function parsePipShowVersion(stdout: string): string {
  return /^Version:\s*(\S+)\s*$/m.exec(stdout)?.[1] ?? ''
}

async function readNpmPackageVersion(packageJsonPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fsp.readFile(packageJsonPath, 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 安装器主体
// ---------------------------------------------------------------------------

export class BinaryManager {
  private readonly operationMutex = new Mutex()
  private snapshotCache: { data: Record<string, BinaryToolSnapshot>; at: number } | null = null
  private snapshotProbeInFlight: Promise<void> | null = null

  /**
   * 主计算的工具快照（V2 getToolSnapshots 形状：application 与 availability 是两个独立
   * 事实）。刻意不取 mutation mutex——慢安装不得隐藏已发布的事实（V2 同款注释语义）。
   */
  async getToolSnapshots(names: readonly string[]): Promise<Record<string, BinaryToolSnapshot>> {
    names // v0.3.4-2：探针面固定为全部预设（2 项），names 仅供 IPC 合同兼容。
    // v0.3.4-2（用户裁决）：快照缓存 + 后台重探（stale-while-revalidate）——/code 页
    // 打开时的"安装"按钮假象来自 3-5s 的探针窗口（hermes 系统 .exe 的 --version 挂到
    // 超时）。有缓存即秒回旧状态，后台重探完成后 broadcastChanged → 渲染层经
    // onChanged 回路自动刷新。冷却 15s 防重探风暴；安装/卸载后强制重探。
    if (this.snapshotProbeInFlight) {
      await this.snapshotProbeInFlight
      return this.snapshotCache?.data ?? {}
    }
    if (this.snapshotCache) {
      if (Date.now() - this.snapshotCache.at > SNAPSHOT_REFRESH_COOLDOWN_MS) {
        this.startBackgroundSnapshotRefresh()
      }
      return this.snapshotCache.data
    }
    const seeded = await this.readSnapshotCacheFile()
    if (seeded) {
      this.snapshotCache = { data: seeded, at: Date.now() }
      this.startBackgroundSnapshotRefresh()
      return seeded
    }
    return this.refreshSnapshotCache()
  }

  private startBackgroundSnapshotRefresh(): void {
    this.snapshotProbeInFlight = this.refreshSnapshotCache()
      .then(() => this.broadcastChanged())
      .catch((error) => logger.warn('Background snapshot refresh failed', error as Error))
      .finally(() => {
        this.snapshotProbeInFlight = null
      })
  }

  /** 并行探针全部工具 + 更新内存/文件缓存。 */
  private async refreshSnapshotCache(): Promise<Record<string, BinaryToolSnapshot>> {
    const names = BINARY_TOOL_PRESETS.map((preset) => preset.executable)
    const entries = await Promise.all(
      names.map(async (name) => {
        const plan = TOOL_PLANS.get(name)
        const snapshot: BinaryToolSnapshot = plan
          ? await this.snapshotTool(plan)
          : { name, application: 'absent', availability: { source: 'none' } }
        return [name, snapshot] as const
      })
    )
    const data = Object.fromEntries(entries)
    this.snapshotCache = { data, at: Date.now() }
    await this.writeSnapshotCacheFile(data).catch((error) => {
      logger.warn('Failed to persist snapshot cache', error as Error)
    })
    return data
  }

  private async readSnapshotCacheFile(): Promise<Record<string, BinaryToolSnapshot> | null> {
    try {
      const raw = await fsp.readFile(path.join(cacheRoot(), SNAPSHOT_CACHE_FILENAME), 'utf-8')
      const parsed = JSON.parse(raw) as { data?: Record<string, BinaryToolSnapshot> }
      return parsed.data ?? null
    } catch {
      return null
    }
  }

  private async writeSnapshotCacheFile(data: Record<string, BinaryToolSnapshot>): Promise<void> {
    await fsp.writeFile(
      path.join(cacheRoot(), SNAPSHOT_CACHE_FILENAME),
      JSON.stringify({ at: Date.now(), data }, null, 2),
      'utf-8'
    )
  }

  private async snapshotTool(plan: ToolPlan): Promise<BinaryToolSnapshot> {
    const managedPath = managedBinaryPath(plan)
    if (await pathExists(managedPath)) {
      const version = await readToolVersionMarker(plan.name)
      // broken 判定：requiredPeer 校验失败（npm 型）、或 --version 探针失败（批次5：
      // 装了但跑不起来——peer 缺失/损坏/版本过旧）。broken 也算"装了"（V2 语义）。
      let application: BinaryApplicationStatus = 'applied'
      if (plan.kind === 'npm' && plan.preset.requiredPeer) {
        application = this.hasRequiredRuntimeDependencies(plan.name, managedPath) ? 'applied' : 'broken'
      }
      const probe = await probeBinary(managedPath)
      if (!probe.runnable) application = 'broken'
      return {
        name: plan.name,
        application,
        availability: {
          source: 'managed',
          path: managedPath,
          ...((version ?? probe.version) ? { version: version ?? probe.version } : {})
        }
      }
    }
    const systemPath = await probeSystemPath(plan.preset.executable)
    if (systemPath) {
      // 批次5 真机加固：PATH 命中 ≠ 可执行（同名异物/缺子命令/损坏安装）。availability
      // 授权执行——探针失败按 V2 语义收敛为 source:'none'（不为不可跑的二进制背书），
      // UI 回落到安装面；探针输出的版本照实携带供展示。
      const probe = await probeBinary(systemPath)
      if (!probe.runnable) {
        logger.warn(`code-mate: system "${plan.preset.executable}" at ${systemPath} failed the --version probe; treating as not available`)
        return { name: plan.name, application: 'absent', availability: { source: 'none' } }
      }
      return {
        name: plan.name,
        application: 'absent',
        availability: { source: 'system', path: systemPath, ...(probe.version ? { version: probe.version } : {}) }
      }
    }
    return { name: plan.name, application: 'absent', availability: { source: 'none' } }
  }

  /**
   * V2 BinaryManager.ts:1194-1216 逐字移植（MISE_REQUIRED_PEERS → REQUIRED_PEERS，其余
   * 不动）：requiredPeer 以宿主自身入口的解析方式校验；宿主缺失视为配方重组而非丢 peer
   * （never fail closed），peer 缺失才判 broken。
   */
  private hasRequiredRuntimeDependencies(tool: string, entryPath: string): boolean {
    const required = REQUIRED_PEERS.get(tool)
    if (!required) return true
    let hostEntry: string
    try {
      hostEntry = createRequire(entryPath).resolve(required.host)
    } catch {
      // An absent host means the recipe restructured its packages, which is not
      // evidence that THIS install lost the peer — never fail a tool closed on it.
      return true
    }
    try {
      createRequire(hostEntry).resolve(required.peer)
      return true
    } catch (error) {
      logger.warn('Managed tool dependency tree is incomplete', {
        tool,
        ...required,
        error: this.errorMessage(error)
      })
      return false
    }
  }

  /** 安装（mutex 串行）。message 经 redactSecretText 清洗。 */
  installTool(name: BinaryToolName): Promise<BinaryOperationResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return Promise.resolve({ success: false, message: `Unknown managed tool: ${name}` })
    return this.operationMutex.runExclusive(async () => {
      try {
        if (plan.kind === 'npm') await this.installNpmTool(plan)
        else await this.installVenvTool(plan)
        // v0.3.4-2：成功后强制重探——紧随的 broadcast 让渲染层直接命中新状态，
        // 不再闪回安装前旧态。
        await this.refreshSnapshotCache().catch((error) =>
          logger.warn('Post-install snapshot refresh failed', error as Error)
        )
        return { success: true as const }
      } catch (error) {
        const message = redactSecretText(error instanceof Error ? error.message : this.errorMessage(error))
        logger.warn(`Failed to install managed tool ${name}`, { error: message })
        return { success: false as const, message }
      } finally {
        this.broadcastChanged()
      }
    })
  }

  /** dsh（npm 型）：受管 node → npm install --prefix → 版本标记 → bundle 装配（dshmarket + PPT）。 */
  private async installNpmTool(plan: ToolPlan): Promise<void> {
    const runtime = await ensureNodeRuntime()
    const dir = toolDir(plan.name)
    await fsp.mkdir(dir, { recursive: true })
    // PATH 首位钉受管 node（npm shim 再启 node 时取它）；缓存钉 CodeMate 子树。
    // PATH 键经 withPathPrepend 规范化（Windows process.env 副本的键名是 'Path'，
    // 与新写的 'PATH' 并存时 spawn 生效方是未定义行为）。
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? runtime.dir : path.join(runtime.dir, 'bin')
    const env: NodeJS.ProcessEnv = withPathPrepend(process.env, [nodeBinDir], pathSep)
    env.npm_config_cache = path.join(cacheRoot(), 'npm')
    env.npm_config_registry = NPM_REGISTRY_MIRROR
    // 批次5：pnpm store 也钉进 CodeMate 子树（dshmarket 在 harness 内装插件时
    // 继承此 env → pnpm 子进程的 store 落点受控，卸载=删子树仍成立）。
    env.npm_config_store_dir = path.join(cacheRoot(), 'pnpm-store')
    await this.runCommand(
      runtime.npmBin,
      ['install', '--prefix', dir, `${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`],
      {
        env,
        label: `npm install ${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`
      }
    )

    const managedPath = managedBinaryPath(plan)
    if (!(await pathExists(managedPath))) {
      throw new Error(
        `npm install finished but ${managedPath} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
    }

    // v0.3.4-2：bundle 装配——dshmarket（插件市场）+ PPT（社区预构建 tgz）。
    // 全走 dsh 自带的 `plugin add` 命令（官方 bundle 安装通道：pnpm add 到 profile 树
    // + reconcilePlugins 自动把声明 dsh.bundle 的依赖加进 dsh.profile.bundles）。
    //
    // 两次真机事故的命门都在这条链的环境上：
    // ① DSH_HOME 必须显式传入——runPlugin 内 resolveProfileDir → resolveDshHome() 读
    //    此环境变量；缺省时 profile 解析到 ~/.dsh（默认 home），而 harness 启动时带
    //    DSH_HOME={CodeMate}/home/dsh → 装进 A 处、运行读 B 处，市场永远不出现。
    // ② pnpm 供给弃用 corepack——corepack 只造 shim，pnpm 本体在首次运行时才下载，
    //    且 corepack 不吃 npm_config_registry（有自己的 COREPACK_NPM_REGISTRY），
    //    网络不佳时静默挂死。改用 npm 装进 dsh 安装树（npmmirror 钉死、shim 落
    //    node_modules/.bin——已在 PATH）。
    const binJs = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, 'pnpm'], {
      env,
      label: 'npm install pnpm (bundle toolchain)'
    })
    const bundleEnv = withPathPrepend(env, [path.join(dir, 'node_modules', '.bin')], pathSep)
    bundleEnv.DSH_HOME = deepSeekHarnessHome()
    await this.runCommand(
      runtime.nodeBin,
      [binJs, 'plugin', '--profile', 'web', 'add', 'dshmarket'],
      { env: bundleEnv, label: 'dsh plugin add dshmarket', timeoutMs: 300_000 }
    )
    logger.info('dshmarket bundle installed')

    // v0.3.4-2 真机修正：PPT 从 registry 装 `dsh-ppt@latest`（0.4.5，官方 DSH 演示文稿
    // 插件——"Markdown 生成网页放映与可编辑 PPTX"，零依赖自包含，声明 dsh.bundle ✓）。
    // 弃用社区 tgz（0.1.1-rc.2-desktop 旧构建）与其 composer（npm 私有件，依赖
    // dsh-ppt@0.1.1-rc.2 在 registry 已被 0.4.5 取代 → ERR_PNPM_NO_MATCHING_VERSION，
    // 真机复现实证）。registry 通道走官方 reconcilePlugins，无需 fork 侧合入。
    await this.runCommand(
      runtime.nodeBin,
      [binJs, 'plugin', '--profile', 'web', 'add', 'dsh-ppt'],
      { env: bundleEnv, label: 'dsh plugin add dsh-ppt', timeoutMs: 300_000 }
    )
    logger.info('dsh-ppt bundle installed')

    const version = await readNpmPackageVersion(
      path.join(dir, 'node_modules', ...plan.preset.packageName.split('/'), 'package.json')
    )
    await fsp.writeFile(path.join(dir, TOOL_VERSION_MARKER), version, 'utf-8')
  }

  /** hermes（pipx 型 → venv 等价）：受管 CPython → python -m venv → venv pip install。 */
  private async installVenvTool(plan: ToolPlan): Promise<void> {
    const { pythonBin } = await ensurePythonRuntime()
    const dir = toolDir(plan.name)
    await fsp.rm(dir, { recursive: true, force: true })
    await this.runCommand(pythonBin, ['-m', 'venv', dir], {
      env: { ...process.env },
      label: `python -m venv ${plan.name}`
    })
    const venvPython = isWin ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python3')
    if (!(await pathExists(venvPython))) {
      throw new Error(`venv created but ${venvPython} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`)
    }
    // fork 缝：extras 数据（pipxExtras:['web']）留在 shared 预设，venv 规格按用户裁决写死
    // 为 <packageName>[web]；official 源在前、清华镜像在后（pip 按序尝试）。
    const pipSpec = `${plan.preset.packageName}[web]`
    await this.runCommand(
      venvPython,
      [
        '-m',
        'pip',
        'install',
        '--cache-dir',
        path.join(cacheRoot(), 'pip'),
        '--index-url',
        PYPI_OFFICIAL_INDEX,
        '--extra-index-url',
        PYPI_TSINGHUA_INDEX,
        pipSpec
      ],
      { env: { ...process.env }, label: `pip install ${pipSpec}` }
    )
    // 版本标记：pip show 解析 Version 行；解析失败留空。
    let version = ''
    try {
      version = parsePipShowVersion(
        await this.runCommand(venvPython, ['-m', 'pip', 'show', plan.preset.packageName], {
          env: { ...process.env },
          label: `pip show ${plan.preset.packageName}`
        })
      )
    } catch (error) {
      logger.warn(`Failed to resolve installed version of ${plan.preset.packageName}`, {
        error: this.errorMessage(error)
      })
    }
    await fsp.writeFile(path.join(dir, TOOL_VERSION_MARKER), version, 'utf-8')
  }

  /** 卸载（mutex 串行）：删工具目录 + 整个同类运行时根（node↔dsh、python↔hermes）。
   * 批次5 真机事故修复：taskkill 后原生 .node 的 DLL 锁异步释放，立即 rm 撞 EPERM
   * （sharp-win32-x64.node 实证）——改逐项遍历删除 + 重试退避（removeTree.ts）。
   * v0.3.4-2：运行时改为删 kind 根（runtime/node 整目录）——NODE_VERSION 跨版本升级
   * 后旧版本目录不再残留，portable"卸载=零残留"在版本演进下仍成立。 */
  async removeTool(name: BinaryToolName): Promise<BinaryRemoveResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { removed: false, message: `Unknown managed tool: ${name}` }
    return this.operationMutex.runExclusive(async () => {
      try {
        const toolGone = await removeTreeWithRetry(toolDir(plan.name))
        // fork 缝：运行时 1:1 映射写死（node↔dsh、python↔hermes；V2 由 mise 统一 prune）。
        const runtimeKindRoot = path.join(codeMateRuntimeRoot(), plan.runtime)
        const runtimeGone = await removeTreeWithRetry(runtimeKindRoot)
        if (!toolGone || !runtimeGone) {
          const locked = !toolGone ? toolDir(plan.name) : runtimeKindRoot
          const message = `Some files are still in use (locked by a running process or antivirus). Close the tool and retry in a moment. Locked: ${locked}`
          logger.warn(`Failed to fully remove managed tool ${name}: ${message}`)
          return { removed: false, message: redactSecretText(message) }
        }
        // v0.3.4-2：同安装——卸载后强制重探，广播命中的是已移除状态。
        await this.refreshSnapshotCache().catch((error) =>
          logger.warn('Post-remove snapshot refresh failed', error as Error)
        )
        return { removed: true }
      } catch (error) {
        const message = redactSecretText(error instanceof Error ? error.message : this.errorMessage(error))
        logger.warn(`Failed to remove managed tool ${name}`, { error: message })
        return { removed: false, message }
      } finally {
        this.broadcastChanged()
      }
    })
  }

  /** 最新版本（尽力而为，失败返回空对象不抛）：dsh 走受管 npm view；hermes 走 PyPI JSON API。 */
  async getLatestVersions(): Promise<Record<BinaryToolName, string | undefined>> {
    const [dsh, hermes] = await Promise.all([this.latestNpmVersion('dsh'), this.latestPypiVersion('hermes')])
    return { dsh, hermes }
  }

  private async latestNpmVersion(name: string): Promise<string | undefined> {
    const plan = TOOL_PLANS.get(name)
    if (!plan || plan.kind !== 'npm') return undefined
    if (!(await isNodeRuntimeInstalled())) return undefined
    try {
      const runtime = await ensureNodeRuntime()
      // 通道与安装同锚（DSH_NPM_DIST_TAG）：查 next tag 的版本，与安装语义恒一致。
      const stdout = await this.runCommand(
        runtime.npmBin,
        ['view', `${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`, 'version'],
        {
          env: { ...process.env, npm_config_registry: NPM_REGISTRY_MIRROR },
          label: `npm view ${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`,
          timeoutMs: NPM_VIEW_TIMEOUT_MS
      })
      return stdout.trim().split(/\r?\n/, 1)[0]?.trim() || undefined
    } catch (error) {
      logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { error: this.errorMessage(error) })
      return undefined
    }
  }

  private async latestPypiVersion(name: string): Promise<string | undefined> {
    const plan = TOOL_PLANS.get(name)
    if (!plan || plan.kind !== 'venv') return undefined
    try {
      const response = await fetch(`https://pypi.org/pypi/${plan.preset.packageName}/json`, {
        signal: AbortSignal.timeout(PYPI_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { info?: { version?: unknown } }
      return typeof payload.info?.version === 'string' ? payload.info.version : undefined
    } catch (error) {
      logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { error: this.errorMessage(error) })
      return undefined
    }
  }

  /** V2 broadcastAvailabilityChanged 的 fork 等价：无载荷全窗广播，消费者重拉快照。 */
  private broadcastChanged(): void {
    try {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_Binary_Changed)
      }
    } catch (error) {
      // 下一份快照是权威事实；通知失败可恢复（V2 同款注释语义）。
      logger.warn('Failed to broadcast binary availability change', { error: this.errorMessage(error) })
    }
  }

  private runCommand(
    executable: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; label: string; timeoutMs?: number }
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      // crossPlatformSpawn（cross-spawn）负责 Windows .cmd 的 cmd.exe 转发与逐参引号。
      const child = crossPlatformSpawn(executable, args, { env: options.env })
      let stdout = ''
      let stderr = ''
      const appendTail = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-OUTPUT_TAIL_LIMIT)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendTail(stdout, chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendTail(stderr, chunk)
      })
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`${options.label} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(new Error(`${options.label} failed to start: ${error.message}`))
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) return resolve(stdout)
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(new Error(`${options.label} exited with code ${code}${output ? `\n${output}` : ''}`))
      })
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export const binaryManager = new BinaryManager()
