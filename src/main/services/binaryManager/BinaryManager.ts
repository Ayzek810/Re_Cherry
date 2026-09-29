// fork 缝（原创）：V2 为 mise 驱动，本件为 portable 等价实现——快照/操作状态机/mutex 串行/
// availability 广播的形状照抄 V2 src/main/services/binaryManager/BinaryManager.ts，mise 命令
// 面全部替换为 npm --prefix / python venv + pip（设计来源：V2 BinaryManager + pythonRuntime，
// 勾勒自勘查报告结论）。一切钉在 {userData}/Data/CodeMate/ 子树：不改
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
import {
  cacheRoot,
  codeMateRuntimeRoot,
  codeMateToolHome,
  deepSeekHarnessHome
} from '@main/services/deepSeekHarness/paths'
import { withPathPrepend } from '@main/utils/shellEnv'
import { judgeManagedApplication } from './applicationStatus'
import { buildInPlace } from './atomicSwap'
import { createProgressThrottle, type DownloadProgress, selectProgressUpdate } from './downloadFile'
import {
  managedBinaryPathFor,
  type ManagedToolKind,
  managedToolKind,
  sourceTreeDir,
  sourceVenvDir,
  sourceVenvPython,
  toolDir
} from './layout'
import { installMarketBundle, nodeMarketIo, readProfileBundleVersion } from './marketBaseline'
import { NPM_REGISTRY_MIRROR } from './registry'
import { removeTreeWithRetry } from './removeTree'
import { DEFAULT_COMMAND_TIMEOUT_MS, runBoundedCommand } from './runCommand'
import {
  deployFrontDist,
  downloadSourceZip,
  extractSourceTree,
  parsePyprojectDependencies,
  resolveHeadSha,
  seedUserConfig
} from './sourceInstaller'
import { IpcChannel } from '@shared/IpcChannel'
import type { InstallProgressStep } from '@shared/types/installProgress'
import { redactSecretText } from '@shared/utils/redaction'

import { type BinaryToolName, type BinaryToolPreset, BINARY_TOOL_PRESETS } from './presets'
import { ensureNodeRuntime, ensurePythonRuntime, isNodeRuntimeInstalled, NODE_VERSION } from './runtimeDownloader'

const logger = loggerService.withContext('BinaryManager')

// v0.3.4-2：快照 stale-while-revalidate 的缓存文件与后台重探冷却。
const SNAPSHOT_CACHE_FILENAME = 'snapshot-cache.json'
const SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000

// V2 快照/操作超时预算的等价裁剪：安装是分钟级（V2 MISE_INSTALL_TIMEOUT_MS 同量级），
// 查询是秒级。命令超时预算已抽到 runCommand（市场通道共用同一个默认值）。
const NPM_VIEW_TIMEOUT_MS = 15_000
const PYPI_TIMEOUT_MS = 10_000

// fork 缝：registry 固定走 npmmirror（V2 走用户代理/区域策略 + mise 内部解析；portable
// 安装器为可预期行为写死镜像）。pip 源 official 在前、清华镜像在后（pip 按序尝试）——
// 与 V2 的清华镜像策略对应（V2 另有腾讯镜像背书，fork 裁为单镜像）。
// v0.4.5-1：镜像/备用源常量已单点到 registry.ts（市场通道共用同一份，见该件注释）。
// v0.3.4-2（用户裁决）：dsh 通道锚 npm 的 `next` dist-tag——社区的当前代际发在 next
// （0.1.7-rc.2），`latest` 停在 0.1.5-rc.3 不动；锚 latest 就永远收不到新一代（真机
// 取证：用户对比社区桌面壳发现"已经到 0.17 而这里还是 0.15 且没有推送更新"）。
// 安装与更新检查共用此 tag，语义恒对齐。
const DSH_NPM_DIST_TAG = 'next'
const PYPI_OFFICIAL_INDEX = 'https://pypi.org/simple'
const PYPI_TSINGHUA_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
/**
 * PyPI **JSON API** 的双源（与上面的 simple 索引两源一一对应）。bandersnatch 系镜像同样
 * 伺服 `/pypi/<name>/json`，故"版本查询"与"安装抓包"可以用同一对源，不会一半通一半不通。
 */
const PYPI_JSON_BASES = ['https://pypi.org/pypi', 'https://pypi.tuna.tsinghua.edu.cn/pypi'] as const

const TOOL_VERSION_MARKER = '.codemate-version'

/** 失败原因在快照里保留的字符数（够看到 pnpm/npm 的关键几行，又不至于把缓存写肿）。 */
const INSTALL_FAILURE_DETAIL_LIMIT = 600

// v0.3.4-2（用户裁决）：通道版本可见化——主进程启动即打一行安装通道，日志里一眼
// 可辨运行中的代码是否加载了本次改动（真机取证：dev 未重启时 npm 日志显示旧 spec，
// "改了没生效"与"代码没改"无法区分——这行日志终结歧义）。
logger.info(`dsh install channel: @${DSH_NPM_DIST_TAG} (node ${NODE_VERSION})`)

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
  /**
   * v0.4.5-1：该工具**最近一次**安装/升级失败的原始原因（已 redactSecretText 清洗）。
   * 主进程持有并随快照下发/落盘，故渲染层的失败行刷新页面后依然在——此前失败原因只活在
   * 一次 toast 里，用户回头再看就没了。
   */
  lastFailure?: string
}

export type BinaryOperationResult = { success: true } | { success: false; message: string }

export type BinaryRemoveResult = { removed: boolean; message?: string }

/** v0.4.5：手动检查更新的结论（渲染层按钮的结果反馈与版本卡注入面）。
 * v0.4.5-1（O1）：加 `source` 分态——只有受管安装才谈得上"本应用可升级"。 */
export type BinaryCheckUpdatesResult =
  | {
      success: true
      /** 解析到的安装来源；非 managed 时 latest/current 无意义（不查、也不比）。 */
      source: BinaryAvailability['source']
      current?: string
      latest?: string
      canUpgrade: boolean
    }
  | { success: false; message: string }

// ---------------------------------------------------------------------------
// 工具计划：shared 预设 → fork 安装后端（install: 'npm' → npm --prefix；'pipx' → venv）
// ---------------------------------------------------------------------------

interface ToolPlan {
  name: string
  preset: BinaryToolPreset
  kind: ManagedToolKind
  /** 1:1 运行时映射（node↔dsh、python↔hermes/paper-agent；fork 缝：写死，V2 由 mise 统一管理）。 */
  runtime: 'node' | 'python'
}

function toToolPlan(preset: BinaryToolPreset): ToolPlan | undefined {
  const kind = managedToolKind(preset)
  if (!kind) {
    logger.warn(`Managed installer does not support backend "${preset.install}" for tool ${preset.executable}`)
    return undefined
  }
  // 源码型（'source'：GitHub 树 + venv 依赖 + 前端构建）与 venv 型同为受管 CPython。
  return { name: preset.executable, preset, kind, runtime: kind === 'npm' ? 'node' : 'python' }
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

/** codeload zip 的顶层包裹目录名（GitHub 固定为 `<RepoName>-<sha>`）。 */
function sourceRepoName(plan: ToolPlan): string {
  const slug = plan.preset.repo ?? plan.preset.packageName
  return slug.split('/')[1] ?? plan.name
}

/**
 * 受管可执行文件的落点（v0.4.5-1：布局知识单点到 layout.ts，resolveBinary 与
 * PaperAgentService 共用同一份）。此处的 throw 只在"预设表出现无布局的后端"时可达——
 * 那是安装器自己的配置错误，应当响亮失败而不是猜路径。
 */
function managedBinaryPath(plan: ToolPlan): string {
  const target = managedBinaryPathFor(plan.name)
  if (!target) throw new Error(`No managed layout is registered for tool "${plan.name}"`)
  return target
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
   * v0.4.5-1：每个工具最近一次的安装失败原因（executable → 已清洗的消息）。
   * 生命周期与工具状态同档：开始新一次尝试时清除、失败时写入、卸载成功时清除。随快照落盘，
   * 故"上次为什么失败"在重启后仍可读。
   */
  private readonly installFailures = new Map<string, string>()

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
      // v0.4.5-1：判定抽到 applicationStatus.ts（纯函数 + 单测）。最要紧的一条是**版本标记
      // 缺失 ⇒ broken**——安装器把它写在最后，"核心换新、市场没换"的半成品此前被判 applied
      // 且显示"最新版本"（真机反馈：升级成功但插件市场不可用，还没有重试入口）。
      const probe = await probeBinary(managedPath)
      const application = judgeManagedApplication({
        kind: plan.kind,
        hasVersionMarker: !!version,
        probeRunnable: probe.runnable,
        ...(plan.kind === 'npm' && plan.preset.requiredPeer
          ? { requiredPeerSatisfied: this.hasRequiredRuntimeDependencies(plan.name, managedPath) }
          : {}),
        ...(plan.kind === 'source'
          ? {
              frontDeployed: await pathExists(path.join(codeMateToolHome(plan.name), 'front', 'dist', 'index.html'))
            }
          : {})
      })
      return {
        name: plan.name,
        application,
        availability: {
          source: 'managed',
          path: managedPath,
          ...((version ?? probe.version) ? { version: version ?? probe.version } : {})
        },
        ...(this.installFailures.get(plan.name) ? { lastFailure: this.installFailures.get(plan.name) } : {})
      }
    }
    // v0.4.5 源码型无 PATH 可执行物（其入口恒为受管 venv 解释器）——不探系统 PATH，
    // 免得路径上恰好有个同名异物被当成"已装（系统）"。
    if (plan.kind === 'source') {
      return { name: plan.name, application: 'absent', availability: { source: 'none' } }
    }
    const systemPath = await probeSystemPath(plan.preset.executable)
    if (systemPath) {
      // 批次5 真机加固：PATH 命中 ≠ 可执行（同名异物/缺子命令/损坏安装）。availability
      // 授权执行——探针失败按 V2 语义收敛为 source:'none'（不为不可跑的二进制背书），
      // UI 回落到安装面；探针输出的版本照实携带供展示。
      const probe = await probeBinary(systemPath)
      if (!probe.runnable) {
        logger.warn(
          `code-mate: system "${plan.preset.executable}" at ${systemPath} failed the --version probe; treating as not available`
        )
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

  /**
   * 安装（mutex 串行）。message 经 redactSecretText 清洗。
   *
   * `targetVersion`（v0.4.5-1）来自渲染层"检查更新"的结论：检查到 A 就装 A。此前这个入参
   * 被渲染层 `void` 掉，装的恒是"点按钮那一刻的通道最新版"（`@next` 这类漂移 tag 下就是
   * "报 A 装 B"）。npm/venv 型按精确版本下 spec；源码型见 installSourceTool 的说明。
   */
  installTool(name: BinaryToolName, targetVersion?: string): Promise<BinaryOperationResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return Promise.resolve({ success: false, message: `Unknown managed tool: ${name}` })
    return this.operationMutex.runExclusive(async () => {
      // 新一次尝试开始：清掉上一次的失败记忆（失败行只在"上次失败且当前不在忙"时出现）。
      this.installFailures.delete(name)
      try {
        if (plan.kind === 'npm') await this.installNpmTool(plan, targetVersion)
        else if (plan.kind === 'venv') await this.installVenvTool(plan, targetVersion)
        else await this.installSourceTool(plan, targetVersion)
        // v0.3.4-2：成功后强制重探——紧随的 broadcast 让渲染层直接命中新状态，
        // 不再闪回安装前旧态。
        await this.refreshSnapshotCache().catch((error) =>
          logger.warn('Post-install snapshot refresh failed', error as Error)
        )
        return { success: true as const }
      } catch (error) {
        const message = redactSecretText(error instanceof Error ? error.message : this.errorMessage(error))
        logger.warn(`Failed to install managed tool ${name}`, { error: message })
        // v0.4.5-1：把原因留在主进程（随快照下发/落盘）——渲染层的失败行据此持久显示，
        // 不再"刷新一下就没原因了"。截断避免把整段 pnpm 输出写进快照缓存。
        this.installFailures.set(name, message.slice(0, INSTALL_FAILURE_DETAIL_LIMIT))
        return { success: false as const, message }
      } finally {
        this.broadcastChanged()
      }
    })
  }

  /** dsh（npm 型）：受管 node → npm install --prefix → 版本标记 → bundle 装配（dshmarket + PPT）。 */
  private async installNpmTool(plan: ToolPlan, targetVersion?: string): Promise<void> {
    this.broadcastInstallProgress(plan.name, 'runtime')
    const runtime = await ensureNodeRuntime(this.progressCallbacks(plan, 'runtime'))
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
    this.broadcastInstallProgress(plan.name, 'install')
    // v0.4.5-1（O2）：带了检查到的版本就钉精确版——"报 A 装 B"正是通道 tag 漂移下的常态。
    // 不设静默回退：装到与用户要求不同的版本，等于把刚修掉的问题换个地方放回去；精确版若
    // 已从 registry 撤下，就如实失败（失败原因现在会持久显示，用户可再点一次检查更新）。
    const npmSpec = targetVersion
      ? `${plan.preset.packageName}@${targetVersion}`
      : `${plan.preset.packageName}@${DSH_NPM_DIST_TAG}`
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, npmSpec], {
      env,
      label: `npm install ${npmSpec}`
    })

    const managedPath = managedBinaryPath(plan)
    if (!(await pathExists(managedPath))) {
      throw new Error(
        `npm install finished but ${managedPath} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
    }

    // v0.3.4-2：bundle 装配——dshmarket（插件市场）+ PPT（社区预构建 tgz）。
    // 全走 dsh 自带的 `plugin add` 命令（官方 bundle 安装通道：pnpm add 到 profile 树
    // + reconcilePlugins 自动把声明 dsh.bundle 的依赖加进 dsh.profile.bundles）。
    // v0.4.5-1：市场那一条已改走受管市场通道（见 marketBaseline.ts）——裸 `add dshmarket`
    // 没有版本契约、没有 --workspace-root、没有装后核验，核心升级后市场停旧版就是这个
    // 缺口造成的（真机反馈"新版本的插件市场不可用"）。
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
    this.broadcastInstallProgress(plan.name, 'toolchain')
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, 'pnpm'], {
      env,
      label: 'npm install pnpm (bundle toolchain)'
    })
    const bundleEnv = withPathPrepend(env, [path.join(dir, 'node_modules', '.bin')], pathSep)
    bundleEnv.DSH_HOME = deepSeekHarnessHome()
    // v0.3.4-2 真机事故：pnpm **不吃 npm_config_registry**（`pnpm config get registry`
    // 恒返回 npmjs.org——真机取证；社区 #337 同款坑）→ 所有 pnpm 操作直连官方 registry，
    // 国内网络下 add 挂死 10 分钟。修复两层：①profile 目录写项目级 .npmrc（pnpm 读
    // 项目配置，且 dshmarket 墙内装插件的 pnpm 子进程 cwd 同在 profile——一并生效）；
    // ②每条 plugin add 显式带 --registry（社区 #337 的修复形态）。
    const webProfileDir = path.join(deepSeekHarnessHome(), 'profiles', 'web')
    const pnpmRegistryArgs = [`--registry=${NPM_REGISTRY_MIRROR}`]
    // v0.3.4-2 真机事故（首装无市场）：首次安装时 profile 尚不存在（harness 首次启动才
    // 创建）——不 mkdir 则 .npmrc 写入 ENOENT → bundle 装配链整体中断，dsh 能启动但
    // 没有市场；卸载不删 home 树 → 首次启动建好 profile 后重装才有。真机现象完全吻合。
    // v0.4.5-1 更正：pnpm ≥10 已不从 .npmrc 读链接器/registry 设置（harness 自己的
    // initProfile 写的是 pnpm-workspace.yaml）——本行对 npm 通道与旧 pnpm 仍有意义，
    // 真正生效的是各条命令的 --registry 与 marketBaseline 的命令环境。
    await fsp.mkdir(webProfileDir, { recursive: true })
    await fsp.writeFile(
      path.join(webProfileDir, '.npmrc'),
      `registry=${NPM_REGISTRY_MIRROR}\nstore-dir=${path.join(cacheRoot(), 'pnpm-store')}\n`,
      'utf-8'
    )
    this.broadcastInstallProgress(plan.name, 'market')
    const market = await installMarketBundle()
    logger.info(`dshmarket bundle installed (${market.version ?? 'version unreadable'})`)

    // v0.3.4-2 真机修正：PPT 从 registry 装 `dsh-ppt@latest`（0.4.5，官方 DSH 演示文稿
    // 插件——技能+工具形态，声明 dsh.bundle ✓）。弃用社区 tgz（0.1.1-rc.2-desktop 旧
    // 构建，挂载形态在新代际下 failed to import）与其 composer（npm 私有件，依赖
    // dsh-ppt@0.1.1-rc.2 在 registry 已被 0.4.5 取代 → ERR_PNPM_NO_MATCHING_VERSION，
    // 真机复现实证）。显式 @latest spec：file:/旧 spec 已存在时 `add <name>` 会被
    // "lockfile up to date" 短路（真机复现），带版本 spec 强制重解析。
    this.broadcastInstallProgress(plan.name, 'ppt')
    await this.runCommand(
      runtime.nodeBin,
      [binJs, 'plugin', '--profile', 'web', 'add', 'dsh-ppt@latest', ...pnpmRegistryArgs],
      { env: bundleEnv, label: 'dsh plugin add dsh-ppt', timeoutMs: 300_000 }
    )
    // v0.4.5-1：pnpm 退出 0 ≠ 插件生效（社区版同款纪律）。PPT bundle 也核验一次——市场
    // 那条有基线兜底，这条至少留下"装没装上"的事实，缺失即安装失败上抛。
    const pptVersion = await readProfileBundleVersion(nodeMarketIo, webProfileDir, 'dsh-ppt')
    if (!pptVersion) {
      throw new Error(
        `dsh plugin add dsh-ppt reported success, but ${path.join(webProfileDir, 'node_modules', 'dsh-ppt')} is not installed`
      )
    }
    logger.info(`dsh-ppt bundle installed (${pptVersion})`)

    const version = await readNpmPackageVersion(
      path.join(dir, 'node_modules', ...plan.preset.packageName.split('/'), 'package.json')
    )
    await fsp.writeFile(path.join(dir, TOOL_VERSION_MARKER), version, 'utf-8')
  }

  /** hermes（pipx 型 → venv 等价）：受管 CPython → python -m venv → venv pip install。 */
  private async installVenvTool(plan: ToolPlan, targetVersion?: string): Promise<void> {
    this.broadcastInstallProgress(plan.name, 'runtime')
    const { pythonBin } = await ensurePythonRuntime(this.progressCallbacks(plan, 'runtime'))
    // 路径用变量名与本类其余处一致，便于对照（venv 的受管布局见 managedBinaryPath）。
    const dir = toolDir(plan.name)
    // v0.4.5-1：改走 buildInPlace——旧实现在建 venv 之前就把整个工具目录删了，pip 阶段一失败
    // 用户手上就只剩残骸（没有旧安装可退）。venv 必须在最终路径上生成（launcher/脚本把绝对
    // 路径写死），故不能走 staging 改名。
    await buildInPlace(dir, async (target) => {
      this.broadcastInstallProgress(plan.name, 'venv')
      await this.runCommand(pythonBin, ['-m', 'venv', target], {
        env: { ...process.env },
        label: `python -m venv ${plan.name}`
      })
      const builtPython = isWin ? path.join(target, 'Scripts', 'python.exe') : path.join(target, 'bin', 'python3')
      if (!(await pathExists(builtPython))) {
        throw new Error(
          `venv created but ${builtPython} is missing; ${target} contains: ${await listDirForDiagnostics(target)}`
        )
      }
      // fork 缝：extras 数据（pipxExtras:['web']）留在 shared 预设，venv 规格按用户裁决写死
      // 为 <packageName>[web]；official 源在前、清华镜像在后（pip 按序尝试）。
      // v0.4.5-1（O2）：带了检查到的版本就钉 `==<版本>`（PyPI 上"报 A 装 B"同样可能——
      // 检查走 JSON API、安装走 pip 解析，两者跨源跨时刻）。
      const pipSpec = targetVersion
        ? `${plan.preset.packageName}[web]==${targetVersion}`
        : `${plan.preset.packageName}[web]`
      this.broadcastInstallProgress(plan.name, 'pip')
      await this.runCommand(
        builtPython,
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
          await this.runCommand(builtPython, ['-m', 'pip', 'show', plan.preset.packageName], {
            env: { ...process.env },
            label: `pip show ${plan.preset.packageName}`
          })
        )
      } catch (error) {
        logger.warn(`Failed to resolve installed version of ${plan.preset.packageName}`, {
          error: this.errorMessage(error)
        })
      }
      await fsp.writeFile(path.join(target, TOOL_VERSION_MARKER), version, 'utf-8')
    })
  }

  /**
   * v0.4.5 源码型（paper-agent）：GitHub 源码树 → 受管 CPython venv 装依赖 → 受管 node
   * 构建前端 → 用户态播种 + 产物部署 → 写 commit SHA 标记。
   *
   * 升级语义 = 再装一次：源码树整目录替换（纯上游代码，无用户态混入），venv 保留（pip
   * 增量解析依赖变更），用户态在 home/<tool> 全程不受影响。"装的恒是该分支当前 HEAD"
   * 沿用 fork 既有的 name-only 安装语义（不做 SHA 钉定）。
   */
  private async installSourceTool(plan: ToolPlan, targetVersion?: string): Promise<void> {
    const { repo, branch } = plan.preset
    if (!repo || !branch) {
      throw new Error(`Source tool "${plan.name}" has no repo/branch configured`)
    }
    this.broadcastInstallProgress(plan.name, 'runtime')
    // v0.4.5-1：两个运行时**串行**下载。原先并行是为了快，但两个各 ~30MB 的档案同时上报
    // 字节进度，进度条会在两条曲线之间来回跳（"真实进度"变成噪声）；串行的总字节数不变，
    // 换来的是一个单调可信的条。
    const { pythonBin } = await ensurePythonRuntime(this.progressCallbacks(plan, 'runtime'))
    const nodeRuntime = await ensureNodeRuntime(this.progressCallbacks(plan, 'runtime'))

    this.broadcastInstallProgress(plan.name, 'source')
    // 先钉 SHA 再按 SHA 取 zip：分支在两次请求之间被推进也不会装到"另一半"。
    const sha = await resolveHeadSha(repo, branch)
    // v0.4.5-1（O2）：源码型**无法**按渲染层给的短 SHA 钉定——codeload 要完整 40 位 SHA，
    // 而版本卡展示的是 8 位短 SHA。这里如实记录"装的是分支当前 HEAD、而非检查时那一个提交"，
    // 卡片会在安装后按实际 SHA 自校正（marker 写的是真 SHA）。
    if (targetVersion && !sha.startsWith(targetVersion)) {
      logger.warn(
        `Source tool ${plan.name}: installing ${sha.slice(0, 8)} while the checked commit was ${targetVersion} (the branch moved)`
      )
    }
    const archivePath = await downloadSourceZip(repo, sha, cacheRoot(), {
      onProgress: this.downloadProgressReporter(plan.name, 'source')
    })
    const dir = toolDir(plan.name)
    await fsp.mkdir(dir, { recursive: true })
    const sourceDir = sourceTreeDir(plan.name)
    try {
      // 下载到 100% 之后还要解压——不换阶段的话条会冻在 100%（三家工具同款形态）。
      this.broadcastInstallProgress(plan.name, 'extract')
      // v0.4.5-1（O8）：把钉住的 SHA 一起交下去——归档顶层目录名必须是 <Repo>-<sha>，
      // 这样"从镜像/代理取回的东西"也能被证伪（对不上即拒绝，见 selectSourceTreeEntry）。
      await extractSourceTree(archivePath, sourceDir, sourceRepoName(plan), sha)
    } finally {
      await fsp.rm(archivePath, { force: true }).catch(() => undefined)
    }

    const venvPython = sourceVenvPython(plan.name)
    if (!(await pathExists(venvPython))) {
      this.broadcastInstallProgress(plan.name, 'venv')
      // v0.4.5-1：venv 用 buildInPlace（在最终路径上生成 + 失败回滚），不再"先删 venv 再建"。
      const venvDir = sourceVenvDir(plan.name)
      await buildInPlace(venvDir, async (target) => {
        await this.runCommand(pythonBin, ['-m', 'venv', target], {
          env: { ...process.env },
          label: `python -m venv ${plan.name}`
        })
        const built = sourceVenvPython(plan.name)
        if (!(await pathExists(built))) {
          throw new Error(
            `venv created but ${built} is missing; ${target} contains: ${await listDirForDiagnostics(target)}`
          )
        }
      })
    }

    this.broadcastInstallProgress(plan.name, 'deps')
    const pyprojectPath = path.join(sourceDir, 'pyproject.toml')
    const dependencies = parsePyprojectDependencies(await fsp.readFile(pyprojectPath, 'utf-8'))
    if (dependencies.length === 0) {
      // 上游布局变了就显式失败——装个空 venv 只会在启动时炸成难懂的 ImportError。
      throw new Error(`No dependencies found in ${pyprojectPath}; the upstream project layout may have changed`)
    }
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
        ...dependencies
      ],
      { env: { ...process.env }, label: `pip install ${plan.name} dependencies` }
    )

    this.broadcastInstallProgress(plan.name, 'front')
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? nodeRuntime.dir : path.join(nodeRuntime.dir, 'bin')
    const frontEnv = withPathPrepend(process.env, [nodeBinDir], pathSep)
    frontEnv.npm_config_cache = path.join(cacheRoot(), 'npm')
    frontEnv.npm_config_registry = NPM_REGISTRY_MIRROR
    const frontDir = path.join(sourceDir, 'front')
    await this.runCommand(nodeRuntime.npmBin, ['install', '--prefix', frontDir], {
      env: frontEnv,
      label: `npm install ${plan.name} front`
    })
    // 直接跑 vite build（跳过上游 `npm run build` 里的 vue-tsc 类型检查——那是开发卫生，
    // 不是安装关键路径；vite 自身仍会捕获导入/语法错误）。
    const viteBin = path.join(frontDir, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite')
    if (!(await pathExists(viteBin))) {
      throw new Error(`vite is missing after npm install: ${viteBin}`)
    }
    await this.runCommand(viteBin, ['build'], {
      env: frontEnv,
      cwd: frontDir,
      label: `vite build ${plan.name}`,
      timeoutMs: 5 * 60_000
    })

    this.broadcastInstallProgress(plan.name, 'deploy')
    const home = codeMateToolHome(plan.name)
    await seedUserConfig(sourceDir, home)
    await deployFrontDist(sourceDir, home)

    // 版本标记 = 短 SHA（展示与更新对比都以它为准；完整 SHA 只用于下载 URL）。
    await fsp.writeFile(path.join(dir, TOOL_VERSION_MARKER), sha.slice(0, 8), 'utf-8')
  }

  /** 该类运行时是否仍被别的已装工具需要（v0.4.5：paper-agent 与 hermes 共享 CPython）。 */
  private async isRuntimeStillNeeded(runtime: 'node' | 'python', removing: string): Promise<boolean> {
    for (const [name, candidate] of TOOL_PLANS) {
      if (name === removing || candidate.runtime !== runtime) continue
      if (await pathExists(toolDir(name))) return true
    }
    return false
  }

  /** 卸载（mutex 串行）：删工具目录 + 整个同类运行时根（node↔dsh、python↔hermes）。
   * 批次5 真机事故修复：taskkill 后原生 .node 的 DLL 锁异步释放，立即 rm 撞 EPERM
   * （sharp-win32-x64.node 实证）——改逐项遍历删除 + 重试退避（removeTree.ts）。
   * v0.3.4-2：运行时改为删 kind 根（runtime/node 整目录）——NODE_VERSION 跨版本升级
   * 后旧版本目录不再残留，portable"卸载=零残留"在版本演进下仍成立。
   * v0.4.5：paper-agent 与 hermes 共享受管 CPython——运行时根改为"该类运行时已无任何
   * 已装工具时才删"（此前 1:1 映射会把对方的解释器一起删掉）；工具目录删除失败时
   * 不删运行时（fail-closed）。用户态 home/<tool> 不删（dsh home 先例）。 */
  async removeTool(name: BinaryToolName): Promise<BinaryRemoveResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { removed: false, message: `Unknown managed tool: ${name}` }
    return this.operationMutex.runExclusive(async () => {
      try {
        const toolGone = await removeTreeWithRetry(toolDir(plan.name))
        const runtimeKindRoot = path.join(codeMateRuntimeRoot(), plan.runtime)
        const runtimeGone =
          toolGone && !(await this.isRuntimeStillNeeded(plan.runtime, plan.name))
            ? await removeTreeWithRetry(runtimeKindRoot)
            : toolGone
        if (!toolGone || !runtimeGone) {
          const locked = !toolGone ? toolDir(plan.name) : runtimeKindRoot
          const message = `Some files are still in use (locked by a running process or antivirus). Close the tool and retry in a moment. Locked: ${locked}`
          logger.warn(`Failed to fully remove managed tool ${name}: ${message}`)
          return { removed: false, message: redactSecretText(message) }
        }
        // v0.3.4-2：同安装——卸载后强制重探，广播命中的是已移除状态。
        // v0.4.5-1：工具没了，它的失败记忆也没意义。
        this.installFailures.delete(name)
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
    // v0.4.5（用户裁决）：paper-agent 纯手动检查——本通道由渲染层在页面挂载时自动调用，
    // 恒不触 GitHub（匿名 API 限流也不该被页面挂载烧掉）。它的最新版本只由 checkUpdates
    // 显式拉取。
    return { dsh, hermes, 'paper-agent': undefined }
  }

  /**
   * v0.4.5：手动"检查更新"。与 getLatestVersions 的区别是**强制重探**——绕过快照 15s
   * 冷却与 stale-while-revalidate，并立刻广播变化，让版本卡的当前版本与结论同一时刻。
   *
   * 每个工具的最新版本来源：npm 型 = `npm view <pkg>@next`；venv 型 = PyPI JSON；
   * source 型 = GitHub 分支 HEAD 的短 SHA（上游无 tag/release，pyproject 版本号恒定）。
   */
  async checkUpdates(name: BinaryToolName): Promise<BinaryCheckUpdatesResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { success: false, message: `Unknown managed tool: ${name}` }
    try {
      const snapshots = await this.refreshSnapshotCache()
      this.broadcastChanged()
      const availability = snapshots[name]?.availability
      // v0.4.5-1（O1）：**非受管安装不谈"版本"**。系统来源（PATH 上的同名工具）本应用既
      // 不知道它是什么版本、也升不了它；旧实现在这种情况下 current 恒为 undefined →
      // canUpgrade:false → 渲染层弹"已是最新版本"，那是对用户的假陈述。这里直接给出来源，
      // 由渲染层说人话（"该系统安装不受本应用管理"）。
      if (availability?.source !== 'managed') {
        return { success: true, source: availability?.source ?? 'none', canUpgrade: false }
      }
      const current = availability.version
      let latest: string | undefined
      if (plan.kind === 'npm') latest = await this.latestNpmVersion(name)
      else if (plan.kind === 'venv') latest = await this.latestPypiVersion(name)
      else {
        const { repo, branch } = plan.preset
        if (!repo || !branch) {
          return { success: false, message: `Source tool "${name}" has no repo/branch configured` }
        }
        latest = (await resolveHeadSha(repo, branch)).slice(0, 8)
      }
      return {
        success: true,
        source: 'managed',
        ...(current ? { current } : {}),
        ...(latest ? { latest } : {}),
        // 升级的前提是"装着一个版本"：未安装时 latest 只是"可装的最新版"，不是"可升级"。
        // 判据是不等（非语义版本串——SHA、预发布串——上这正是"有变化"的诚实含义，与渲染层
        // isNewerVersion 的非语义回退一致）。
        canUpgrade: !!latest && !!current && latest !== current
      }
    } catch (error) {
      const message = redactSecretText(this.errorMessage(error))
      logger.warn(`Failed to check updates for managed tool ${name}`, { error: message })
      return { success: false, message }
    }
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
        }
      )
      return stdout.trim().split(/\r?\n/, 1)[0]?.trim() || undefined
    } catch (error) {
      logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { error: this.errorMessage(error) })
      return undefined
    }
  }

  /**
   * 最新版本查询（PyPI JSON API）。**双源**：pypi.org 在前、清华镜像在后——与安装期
   * `pip install --index-url pypi.org --extra-index-url tsinghua` 的策略对齐。
   * v0.4.5-1 修的是"两半不同源"：安装能退到镜像，而版本查询只有 pypi.org——墙内它不可达时
   * 检查更新就静默无结论（用户看到的是"没有新版本"）。
   */
  private async latestPypiVersion(name: string): Promise<string | undefined> {
    const plan = TOOL_PLANS.get(name)
    if (!plan || plan.kind !== 'venv') return undefined
    const failures: string[] = []
    for (const base of PYPI_JSON_BASES) {
      try {
        const response = await fetch(`${base}/${plan.preset.packageName}/json`, {
          signal: AbortSignal.timeout(PYPI_TIMEOUT_MS)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as { info?: { version?: unknown } }
        if (typeof payload.info?.version === 'string') return payload.info.version
        throw new Error('the response carried no info.version')
      } catch (error) {
        // ASCII 箭头：→ 会被 GBK 控制台啃成乱码（真机日志取证）。
        failures.push(`${base} -> ${this.errorMessage(error)}`)
      }
    }
    logger.warn(`Failed to query latest version of ${plan.preset.packageName}`, { failures })
    return undefined
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

  /** v0.3.4-2（用户裁决）：安装步骤进度广播——渲染层进度条的数据源。step 为 i18n 键尾
   * （code.install_progress.<step>），由渲染层翻译；detail 为语言无关的补充事实（下载字节
   * 数），fraction 为**进度条本体的确定性比例**（0..1，只有可测的阶段才有）。
   *
   * v0.4.5-1（用户反馈"进度条不反映真实下载进度"）：旧载荷只有步骤名，渲染层只能画一个
   * 匀速脉冲的假条。可测的阶段（下载）带上 fraction，渲染层画真条；不可测的阶段
   * （npm/pip/vite 的执行）不编造比例，保持不确定态——**宁可显示"不确定"，不显示假进度**。 */
  private broadcastInstallProgress(
    tool: BinaryToolName,
    step: InstallProgressStep,
    options: { detail?: string; fraction?: number } = {}
  ): void {
    try {
      const { detail, fraction } = options
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IpcChannel.CodeCli_Binary_InstallProgress, {
            tool,
            step,
            ...(detail ? { detail } : {}),
            ...(typeof fraction === 'number' && Number.isFinite(fraction) ? { fraction } : {})
          })
        }
      }
    } catch (error) {
      logger.warn('Failed to broadcast install progress', { error: this.errorMessage(error) })
    }
  }

  /**
   * 下载字节进度 → 进度条（detail 文本 + fraction 比例）。
   *
   * 判定逻辑（节流 / 完成必报 / 单调）是 downloadFile.ts 的纯函数 `selectProgressUpdate`——
   * 放那里是为了可单测；此处只负责 I/O（广播）与"一个 throttle 实例 = 一个阶段"的约定：
   * 调用方按阶段建各自的 reporter，阶段一变就换实例，比例随之从头开始。
   */
  private downloadProgressReporter(
    tool: BinaryToolName,
    step: InstallProgressStep
  ): (progress: DownloadProgress) => void {
    const throttle = createProgressThrottle()
    return (progress) => {
      const update = selectProgressUpdate(throttle, progress)
      if (!update) return
      this.broadcastInstallProgress(tool, step, {
        detail: update.detail,
        ...(update.fraction !== undefined ? { fraction: update.fraction } : {})
      })
    }
  }

  /**
   * 下载器的进度回调组（字节比例 + 阶段切换）。成一个方法是为了让"下载 → 解压"这条链在
   * 三个工具、两种运行时上完全同形：比例按 `step` 上报，阶段切换（解压）由下载器触发。
   */
  private progressCallbacks(
    plan: ToolPlan,
    step: InstallProgressStep
  ): {
    onProgress: (progress: DownloadProgress) => void
    onStep: (next: InstallProgressStep) => void
  } {
    return {
      onProgress: this.downloadProgressReporter(plan.name, step),
      onStep: (next) => this.broadcastInstallProgress(plan.name, next)
    }
  }

  /** v0.4.5-1：命令执行原语抽到 runCommand.ts（市场通道共用），此处保留同一入口名。 */
  private runCommand(
    executable: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; label: string; timeoutMs?: number; cwd?: string }
  ): Promise<string> {
    return runBoundedCommand(executable, args, {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export const binaryManager = new BinaryManager()
