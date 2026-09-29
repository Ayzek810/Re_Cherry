// fork 缝（原创，v0.4.5-1）：dshmarket（插件市场）受管通道。
//
// 背景（真机反馈）：dsh 核心升级后插件市场停在旧版 → 与本代核心不兼容 → 用户报"新版本的
// 插件市场不可用"。机理：dshmarket **不是官方包**（harness 源码里 grep `dshmarket` 零命中），
// 它只是 web profile 目录里的一个普通依赖；官方 in-box bundle 由 `resolveBundleDir` 先从
// dsh 安装目录解析（换核心即换官方包），而 dshmarket 只能由 pnpm 移动。
//
// 本件保证两件事（社区版 dsh-desktop market-baseline 的**目的**，不是它的常量）：
// ① 市场装上了、且可读——装完读回 `node_modules/dshmarket/package.json` 才算数
//    （pnpm 退出 0 ≠ 插件生效）；
// ② 每次启动 Harness 前把"缺失/不可读/链接残留/上次没修完"的市场补上，失败回滚 manifest 并
//    留下次重试的标记；补不上但现有市场还能用时**不阻断启动**。
//
// **为什么不学社区版钉死一个"已验证版本"**（v0.4.5-1 真机回归，本人引入）：社区版的
// `VERIFIED_MARKET_BASELINE = '1.45.1'` 是为**他们那一代** harness 定的；而 dsh 自 0.2.x 起
// 自己就做插件兼容校验。真机日志：
//   dsh: installation rejected: Plugin dshmarket@1.45.1 is incompatible with dsh 0.2.0-rc.2:
//   peerDependencies {"@deepseek-ai/dsh-settings":"^0.1.0-rc.7 || ..."}
// 钉死的结果是：安装必失败、工具因此判 broken、市场永远补不上——把"我们不知道现在是哪一代"
// 变成了硬故障。**版本权威在 dsh，不在这里的常量**：所以本件只装 `dshmarket@latest`（交给
// dsh 的解析器与其自己的兼容闸），核验只要求"装着且版本可读"。
//
// 可测性：本件不 import electron，文件系统与命令执行都走端口注入（main 测试环境 mock 了
// node:fs/node:path）；零参包装是本件对应用侧的默认绑定。

import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { cacheRoot, codeMateToolsRoot, deepSeekHarnessHome, nodeRuntimeDir } from '@main/services/deepSeekHarness/paths'
import { withPathPrepend } from '@main/utils/shellEnv'

import { NPM_REGISTRY_FALLBACK, NPM_REGISTRY_MIRROR } from './registry'
import { DEFAULT_COMMAND_TIMEOUT_MS, runBoundedCommand } from './runCommand'
import { NODE_VERSION } from './runtimeDownloader'

const logger = loggerService.withContext('MarketBaseline')

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 市场所在的 profile（dsh 自带 web 模板，市场恒装在这里）。 */
export const MARKET_PROFILE = 'web'
/** 市场包名（社区版 `MARKET_PACKAGE` 对位）。 */
export const MARKET_PACKAGE = 'dshmarket'
/**
 * 安装规格：dist-tag `latest`，**不钉版本**——理由见文件头（dsh 0.2.x 自己校验插件 peer
 * 兼容性；钉死一个我们无法验证的版本会把安装变成硬故障）。
 */
export const MARKET_INSTALL_SPEC = 'latest'

/** 社区版成对的 [主源, 备用源]；两半（版本解析与抓包）必须同源。 */
const MARKET_REGISTRIES = [NPM_REGISTRY_MIRROR, NPM_REGISTRY_FALLBACK] as const

/** 回退判据：只有"这个源拿不到这个东西"类失败才值得换源，EPERM/EBUSY 换源没意义。 */
const REGISTRY_FALLBACK_PATTERN =
  /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|404|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i

/** pnpm ≥10 从 pnpm-workspace.yaml 读链接器设置（harness `initProfile` 写入的同一份内容）。 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

// ---------------------------------------------------------------------------
// 版本判据（只判"可读"，不判大小）
// ---------------------------------------------------------------------------

export interface SemverVersion {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析严格 semver；不合法返回 null。 */
export function parseSemver(input: string): SemverVersion | null {
  if (typeof input !== 'string') return null
  const match = SEMVER_PATTERN.exec(input.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

/**
 * 市场是否"可用"：装着、版本号可读即可。
 *
 * 刻意**不比对任何下限**：dsh 自己会拒绝与它不兼容的插件版本（真机日志见文件头），
 * 我们再钉一个数只会把 dsh 允许的组合判成坏。缺版本号/不是 semver = 装坏了（半成品或串档）。
 */
export function isUsableMarketVersion(version: string | undefined): boolean {
  return !!version && !!parseSemver(version)
}

// ---------------------------------------------------------------------------
// 端口：文件系统与命令执行（注入以便单测；main 测试环境 mock 了 node:fs）
// ---------------------------------------------------------------------------

export type MarketEntryKind = 'missing' | 'file' | 'directory' | 'link'

export interface MarketIo {
  /** 读文本；缺失/不可读返回 undefined（不抛）。 */
  readText(file: string): Promise<string | undefined>
  writeText(file: string, contents: string): Promise<void>
  removeFile(file: string): Promise<void>
  entryKind(target: string): Promise<MarketEntryKind>
  /** 链接目标；非链接或缺失返回 undefined。 */
  linkTarget(target: string): Promise<string | undefined>
  ensureDir(dir: string): Promise<void>
}

export interface MarketCommandOptions {
  label: string
  /** 本次命令要用的 registry（默认主镜像）；调用方据此同时设 env 与 `--registry=`。 */
  registry?: string
  timeoutMs?: number
}

export type MarketCommandRunner = (args: readonly string[], options: MarketCommandOptions) => Promise<string>

export const nodeMarketIo: MarketIo = {
  async readText(file) {
    try {
      return await fsp.readFile(file, 'utf-8')
    } catch {
      return undefined
    }
  },
  async writeText(file, contents) {
    await fsp.writeFile(file, contents, 'utf-8')
  },
  async removeFile(file) {
    await fsp.rm(file, { force: true })
  },
  async entryKind(target) {
    try {
      const entry = await fsp.lstat(target)
      if (entry.isSymbolicLink()) return 'link'
      return entry.isDirectory() ? 'directory' : 'file'
    } catch {
      return 'missing'
    }
  },
  async linkTarget(target) {
    try {
      return await fsp.readlink(target)
    } catch {
      return undefined
    }
  },
  async ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// 布局与读取
// ---------------------------------------------------------------------------

export interface MarketPaths {
  home: string
  profileDir: string
  manifestPath: string
  nodeModulesDir: string
  /** 未完成的修复标记（社区版 `.desktop-market-install-pending.json` 的 fork 对位）。 */
  pendingPath: string
}

export function marketPaths(dshHome: string): MarketPaths {
  const profileDir = path.join(dshHome, 'profiles', MARKET_PROFILE)
  return {
    home: dshHome,
    profileDir,
    manifestPath: path.join(profileDir, 'package.json'),
    nodeModulesDir: path.join(profileDir, 'node_modules'),
    pendingPath: path.join(profileDir, '.codemate-market-install-pending.json')
  }
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

interface LoadedManifest {
  raw: string
  manifest: ProfileManifest
}

async function readManifest(io: MarketIo, paths: MarketPaths): Promise<LoadedManifest | undefined> {
  const raw = await io.readText(paths.manifestPath)
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return { raw, manifest: parsed as ProfileManifest }
  } catch {
    // 坏 manifest 不猜：当作"没有 profile"处理，调用方各自 fail-closed。
    return undefined
  }
}

/** 读某个 profile 依赖的实际安装版本（链接与实目录两种布局都成立）。 */
export async function readProfileBundleVersion(
  io: MarketIo,
  profileDir: string,
  packageName: string
): Promise<string | undefined> {
  const raw = await io.readText(path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'))
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 市场是否是 `.generations` 链接（社区宿主残留的形态；fork 自己不产生 generation）。 */
async function isGenerationLink(io: MarketIo, paths: MarketPaths): Promise<boolean> {
  const marketPath = path.join(paths.nodeModulesDir, MARKET_PACKAGE)
  if ((await io.entryKind(marketPath)) !== 'link') return false
  return (await io.linkTarget(marketPath))?.includes('.generations') ?? false
}

/** pnpm ≥10 只从 profile 的 pnpm-workspace.yaml 读链接器设置；缺失则补上（幂等）。 */
async function ensurePnpmWorkspaceSettings(io: MarketIo, profileDir: string): Promise<void> {
  if ((await io.entryKind(path.join(profileDir, 'pnpm-workspace.yaml'))) !== 'missing') return
  await io.ensureDir(profileDir)
  await io.writeText(path.join(profileDir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
}

/**
 * 撤下"安装已完成"的声明（harness 与社区宿主的 `.install-complete` 指纹文件）。
 * 修复前必须撤：它是对 package.json + pnpm-lock.yaml 的指纹，留着会让后续启动认为
 * profile 已完整而跳过安装。缺文件时 `rm -f` 无害。
 */
async function clearProfileInstallMarker(io: MarketIo, profileDir: string): Promise<void> {
  await io.removeFile(path.join(profileDir, '.install-complete'))
}

/** manifest 是否"声明了市场"（依赖 + bundle 层都要在，否则视为用户已移除/已禁用）。 */
function declaresMarket(manifest: ProfileManifest): boolean {
  const declared = manifest.dependencies?.[MARKET_PACKAGE]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return !!declared && bundles.includes(MARKET_PACKAGE)
}

// ---------------------------------------------------------------------------
// 命令拼装
// ---------------------------------------------------------------------------

function marketAddArgs(registry: string): string[] {
  return [
    'plugin',
    '--profile',
    MARKET_PROFILE,
    'add',
    '--workspace-root',
    `${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC}`,
    `--registry=${registry}`,
    // CI 环境下 pnpm 默认冻结锁文件，而这里要动的正是锁文件。
    '--no-frozen-lockfile'
  ]
}

function profileInstallArgs(registry: string): string[] {
  return ['plugin', '--profile', MARKET_PROFILE, 'install', '--no-frozen-lockfile', `--registry=${registry}`]
}

async function runWithRegistryFallback(
  runner: MarketCommandRunner,
  buildArgs: (registry: string) => string[],
  label: (registry: string) => string,
  note?: (line: string) => void
): Promise<string> {
  try {
    return await runner(buildArgs(MARKET_REGISTRIES[0]), {
      label: label(MARKET_REGISTRIES[0]),
      registry: MARKET_REGISTRIES[0]
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!REGISTRY_FALLBACK_PATTERN.test(message)) throw error
    note?.(`[market] ${MARKET_REGISTRIES[0]} could not provide the bundle; retrying from ${MARKET_REGISTRIES[1]}`)
    return await runner(buildArgs(MARKET_REGISTRIES[1]), {
      label: label(MARKET_REGISTRIES[1]),
      registry: MARKET_REGISTRIES[1]
    })
  }
}

/** 跑一次"装市场"并核验可读；失败如实抛（调用方决定是阻断还是仅告警）。 */
async function addMarketAndVerify(
  io: MarketIo,
  runner: MarketCommandRunner,
  paths: MarketPaths,
  note?: (line: string) => void
): Promise<string | undefined> {
  await runWithRegistryFallback(
    runner,
    marketAddArgs,
    (registry) => `dsh plugin add ${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC} (${registry})`,
    note
  )
  const version = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  if (!isUsableMarketVersion(version)) {
    throw new Error(
      `${MARKET_PACKAGE} install reported success, but the active version is ${version ?? 'missing'}; the profile may have been left half-installed`
    )
  }
  return version
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface MarketChannelOptions {
  dshHome: string
  io: MarketIo
  runner: MarketCommandRunner
  note?: (line: string) => void
}

export interface MarketInstallOutcome {
  /** 本次是否真的跑了安装（缺省 profile 初始化时也算）。 */
  installed: boolean
  /** 操作结束时读到的市场实际版本（可读时）。 */
  version?: string
}

/**
 * 安装面：把市场装进 web profile（安装器在装配 dsh 时调用）。
 *
 * 顺序有意为之：**先声明再安装**——`add` 失败时若什么都没留下，市场连声明都没了，启动前的
 * 修复就无从下手。声明 + bundle 层先写，失败也能被下一次启动兜住。
 *
 * **失败如实抛**（由调用方决定是否阻断整体安装：市场是 bundle，不该让工具本体装不上）。
 */
export async function installMarketBundleWith(options: MarketChannelOptions): Promise<MarketInstallOutcome> {
  const { io, runner, note } = options
  const paths = marketPaths(options.dshHome)

  let loaded = await readManifest(io, paths)
  if (!loaded) {
    // 首次安装：profile 还不存在，让 dsh 自己按模板建（initProfile 写 manifest / patch /
    // pnpm-workspace.yaml），再回来声明市场。
    note?.('[market] initializing the web profile')
    await io.ensureDir(paths.profileDir)
    await ensurePnpmWorkspaceSettings(io, paths.profileDir)
    await runWithRegistryFallback(runner, profileInstallArgs, (registry) => `dsh plugin init (${registry})`, note)
    loaded = await readManifest(io, paths)
  }
  if (!loaded) throw new Error(`dsh web profile manifest was not created at ${paths.manifestPath}`)

  const declared: ProfileManifest = {
    ...loaded.manifest,
    dependencies: { ...loaded.manifest.dependencies, [MARKET_PACKAGE]: MARKET_INSTALL_SPEC }
  }
  const bundles = declared.dsh?.profile?.bundles ?? []
  declared.dsh = {
    ...declared.dsh,
    profile: {
      ...declared.dsh?.profile,
      bundles: bundles.includes(MARKET_PACKAGE) ? bundles : [...bundles, MARKET_PACKAGE]
    }
  }
  await io.writeText(paths.manifestPath, `${JSON.stringify(declared, undefined, 2)}\n`)
  try {
    const version = await addMarketAndVerify(io, runner, paths, note)
    return { installed: true, ...(version ? { version } : {}) }
  } catch (error) {
    // 声明留下（下次启动的修复据此接手）；pnpm 可能已改过 manifest，还原成进来时的样子。
    await io.writeText(paths.manifestPath, loaded.raw)
    throw error
  }
}

/**
 * 启动前入口：市场"缺失 / 不可读 / 链接残留 / 上次没修完"时补装。
 *
 * 快路径只有两三次文件读；需要修时才动 profile。**前置条件是 Harness 已停**——重装会替换共享
 * 树里的包。失败回滚 manifest 并把待修标记留给下次启动；调用方再决定是否阻断启动
 *（现有市场可加载时不该阻断）。
 */
export async function ensureMarketInstalledWith(options: MarketChannelOptions): Promise<MarketInstallOutcome> {
  const { io, runner, note } = options
  const paths = marketPaths(options.dshHome)
  const loaded = await readManifest(io, paths)
  if (!loaded) return { installed: false }
  // 用户移除/禁用了市场 → 不复活（那是用户意图，不是实现细节）。
  if (!declaresMarket(loaded.manifest)) return { installed: false }

  const installed = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  const linked = await isGenerationLink(io, paths)
  const pending = (await io.entryKind(paths.pendingPath)) !== 'missing'
  if (isUsableMarketVersion(installed) && !linked && !pending) {
    return { installed: false, ...(installed ? { version: installed } : {}) }
  }

  note?.(
    linked
      ? `[market] ${MARKET_PACKAGE} ${installed ?? '(unknown)'} is a link; reinstalling into the shared tree`
      : `[market] (re)installing ${MARKET_PACKAGE} ${installed ?? '(missing)'} as @${MARKET_INSTALL_SPEC}`
  )

  await ensurePnpmWorkspaceSettings(io, paths.profileDir)
  await clearProfileInstallMarker(io, paths.profileDir)
  if (!pending) {
    await io.writeText(paths.pendingPath, `${JSON.stringify({ spec: MARKET_INSTALL_SPEC, at: Date.now() })}\n`)
  }
  try {
    const version = await addMarketAndVerify(io, runner, paths, note)
    await io.removeFile(paths.pendingPath)
    return { installed: true, ...(version ? { version } : {}) }
  } catch (error) {
    // pnpm 可能在失败前就改过包，故 manifest 回滚不等于"树回滚"——待修标记仍在，下次启动再修。
    await io.writeText(paths.manifestPath, loaded.raw)
    throw error
  }
}

/**
 * 现有市场能否撑起这次启动：装着、版本可读、不是 generation 链接。
 * 补装失败（受限网络 / dsh 拒收该版本）不该让用户丢掉本来还能用的 profile。
 */
export async function isMarketUsableWith(io: MarketIo, paths: MarketPaths): Promise<boolean> {
  const marketPath = path.join(paths.nodeModulesDir, MARKET_PACKAGE)
  const kind = await io.entryKind(marketPath)
  if (kind === 'missing') return false
  if (kind === 'link' && ((await io.linkTarget(marketPath))?.includes('.generations') ?? false)) return false
  return isUsableMarketVersion(await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE))
}

// ---------------------------------------------------------------------------
// 应用侧默认绑定
// ---------------------------------------------------------------------------

/** 受管 dsh 的 CLI 入口（npm 型安装布局，与 BinaryManager.installNpmTool 一致）。 */
function managedDshEntry(): string {
  return path.join(codeMateToolsRoot(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function managedNodeBin(): string {
  const dir = nodeRuntimeDir(NODE_VERSION)
  return isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * 受管命令环境（与 BinaryManager.installNpmTool 的 bundleEnv 同形，两处生命周期不同：
 * 那处是安装期、这处是启动前修复）。DSH_HOME 必须显式给——缺省时 profile 解析到 ~/.dsh，
 * 就是"装进 A 处、运行读 B 处"那次真机事故的成因。
 */
function marketCommandEnv(registry: string): NodeJS.ProcessEnv {
  const pathSep = isWin ? ';' : ':'
  const nodeDir = nodeRuntimeDir(NODE_VERSION)
  const nodeBinDir = isWin ? nodeDir : path.join(nodeDir, 'bin')
  const toolsBinDir = path.join(codeMateToolsRoot(), 'dsh', 'node_modules', '.bin')
  const env = withPathPrepend(process.env, [nodeBinDir, toolsBinDir], pathSep)
  env.DSH_HOME = deepSeekHarnessHome()
  env.npm_config_cache = path.join(cacheRoot(), 'npm')
  env.npm_config_store_dir = path.join(cacheRoot(), 'pnpm-store')
  env.npm_config_registry = registry
  return env
}

const managedMarketRunner: MarketCommandRunner = async (args, options) => {
  const nodeBin = managedNodeBin()
  const entry = managedDshEntry()
  for (const required of [nodeBin, entry]) {
    if (!(await pathExists(required))) {
      throw new Error(`${options.label} cannot run: ${required} is missing; install DeepSeek Harness first`)
    }
  }
  return runBoundedCommand(nodeBin, [entry, ...args], {
    env: marketCommandEnv(options.registry ?? NPM_REGISTRY_MIRROR),
    label: options.label,
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  })
}

function defaultMarketOptions(): MarketChannelOptions {
  return {
    dshHome: deepSeekHarnessHome(),
    io: nodeMarketIo,
    runner: managedMarketRunner,
    note: (line) => logger.info(line)
  }
}

/** 安装面入口（BinaryManager 调用）：把市场装进共享树并核验。 */
export function installMarketBundle(): Promise<MarketInstallOutcome> {
  return installMarketBundleWith(defaultMarketOptions())
}

/** 启动前入口（DeepSeekHarnessService 调用）：需要时才补装并核验。 */
export function ensureMarketInstalled(): Promise<MarketInstallOutcome> {
  return ensureMarketInstalledWith(defaultMarketOptions())
}

/** 现有市场是否仍可加载（补装失败时的降级判据）。 */
export function isMarketUsable(): Promise<boolean> {
  return isMarketUsableWith(nodeMarketIo, marketPaths(deepSeekHarnessHome()))
}
