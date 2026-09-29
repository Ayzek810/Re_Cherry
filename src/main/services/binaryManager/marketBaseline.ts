// fork 缝（原创，v0.4.5-1）：dshmarket（插件市场）受管通道。
//
// 背景（真机反馈）：dsh 核心升级成功，插件市场停在旧版 → 与本代核心不兼容 → 用户报
// "新版本的插件市场不可用"，而界面与日志都没有信号。机理：dshmarket **不是官方包**
// （harness 源码里 grep `dshmarket` 零命中），它只是 web profile 目录里的一个普通依赖。
// 官方 in-box bundle（`@deepseek-ai/dsh-base` / `dsh-web-app`）由 `resolveBundleDir`
// 先从 dsh 安装目录解析，所以换核心即换官方包；dshmarket 只能由 pnpm 移动——而旧实现
// 只在 installTool 里裸 `add dshmarket` 一次，没有版本、没有 `--workspace-root`、没有装后
// 核验，失败也没有第二道闸。
//
// 本件照搬社区版 dsh-desktop 的 market-baseline 机制（参考资产/dsh-desktop：
// `src/main/state/market-baseline.ts`、`src/main/state/plugin-upgrade.ts`、
// `packages/dsh-desktop-market-installer/index.js`，MIT），三道闸逐条对齐：
// ① 规格显式：RECOMMENDED_MARKET_VERSION（安装面 range，社区版同名常量对位）+
//    VERIFIED_MARKET_BASELINE（核验面精确版），且必带 `--workspace-root`；
// ② 装后核验：读 `node_modules/dshmarket/package.json` 的实际版本——pnpm 退出 0 ≠ 插件生效；
// ③ 启动前基线修复：低于基线（或市场不是共享树实目录、或留有未完成的修复标记）就重装，
//    目标取 max(基线, manifest 声明, 已装)——**永不降级**；失败回滚 manifest 并留下待修
//    标记，下次启动重试；修复失败但现有市场仍可加载时不阻断启动（社区版同款取舍）。
//
// 与社区版的裁剪（说清为什么不搬）：fork 不建 generation 体系（没有
// generations/projection/desired.json/registry-lock），因此"dshmarket 决不可作为
// generation"只保留"链接形态"判定（`isGenerationLink`）——它现在的唯一用途是识别
// 社区宿主留下的残留；"用户删掉的市场不得复活"（`ensureMarketBaseline` 只在 manifest
// 同时声明了依赖与 bundle 层时才动手）逐字保留，因为那是用户意图，不是实现细节。
//
// 可测性：本件不 import electron，文件系统与命令执行都走端口注入（main 测试环境 mock 了
// node:fs/node:path）；零参包装（`installMarketBundle` / `ensureMarketBaseline`）是本件对
// 应用侧的默认绑定。

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
// 版本契约
// ---------------------------------------------------------------------------

/** 市场所在的 profile（dsh 自带 web 模板，市场恒装在这里）。 */
export const MARKET_PROFILE = 'web'
/** 市场包名（社区版 `MARKET_PACKAGE` 对位）。 */
export const MARKET_PACKAGE = 'dshmarket'
/**
 * 核验面基线（社区版 `VERIFIED_MARKET_BASELINE` 对位）：**精确版，只作下限**。
 * 升级 dsh 代际时与 `DSH_NPM_DIST_TAG` 同批 bump——市场是第三方包，它的可用版本随核心
 * 代际走，两者的版本契约必须一起动。
 */
export const VERIFIED_MARKET_BASELINE = '1.45.1'
/** 安装面规格（社区版 `RECOMMENDED_MARKET_VERSION` 对位）：range，允许装到更新的兼容版。 */
export const RECOMMENDED_MARKET_VERSION = `^${VERIFIED_MARKET_BASELINE}`

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
// semver（社区版 plugin-market-check.ts 逐字移植，只留本件用到的两个函数）
// ---------------------------------------------------------------------------

export interface SemverVersion {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析严格 semver（`1.45.1` / `1.45.1-rc.2`）；不合法返回 null。 */
export function parseSemver(input: string): SemverVersion | null {
  if (typeof input !== 'string') return null
  const match = SEMVER_PATTERN.exec(input.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : []
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

/** 比较 semver：a>b → 1，a<b → -1，相等/都不可解析且字符串相等 → 0（社区版逐字）。 */
export function compareSemver(aStr: string, bStr: string): number {
  const a = parseSemver(aStr)
  const b = parseSemver(bStr)
  if (!a && !b) return aStr.localeCompare(bStr)
  if (!a) return -1
  if (!b) return 1

  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1

  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index]
    const bPart = b.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    const aNumeric = typeof aPart === 'number'
    const bNumeric = typeof bPart === 'number'
    if (aNumeric && !bNumeric) return -1
    if (!aNumeric && bNumeric) return 1
    return aPart > bPart ? 1 : -1
  }
  return 0
}

/** 去掉 range 前缀（`^1.45.1` → `1.45.1`）：manifest 里声明的是 range，比对要的是精确版。 */
export function cleanVersionSpec(spec: string): string {
  return spec.replace(/^[~^v=><\s]+/, '')
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

// ---------------------------------------------------------------------------
// 判定（纯函数，单测的主要落点）
// ---------------------------------------------------------------------------

/** 已装版本是否达到基线（不可解析/缺失一律 false）。 */
export function meetsMarketBaseline(version: string | undefined): boolean {
  if (!version || !parseSemver(version)) return false
  return compareSemver(version, VERIFIED_MARKET_BASELINE) >= 0
}

/**
 * 修复目标版本 = max(基线, manifest 声明, 已装)（社区版同款 reduce）。
 * **永不降级**：装得比基线新就保留——半途完成的安装不该被基线拽回去。
 */
export function selectMarketTargetVersion(input: { declared?: string; installed?: string }): string {
  const candidates = [
    VERIFIED_MARKET_BASELINE,
    input.declared ? cleanVersionSpec(input.declared) : undefined,
    input.installed
  ].filter((version): version is string => !!version && !!parseSemver(version))
  return candidates.reduce(
    (latest, version) => (compareSemver(version, latest) > 0 ? version : latest),
    VERIFIED_MARKET_BASELINE
  )
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

function marketAddArgs(spec: string, registry: string): string[] {
  return [
    'plugin',
    '--profile',
    MARKET_PROFILE,
    'add',
    '--workspace-root',
    `${MARKET_PACKAGE}@${spec}`,
    `--registry=${registry}`,
    // CI 环境下 pnpm 默认冻结锁文件，而这里要动的正是锁文件（社区版同款显式放行）。
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

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export interface MarketChannelOptions {
  dshHome: string
  io: MarketIo
  runner: MarketCommandRunner
  note?: (line: string) => void
}

export interface MarketBaselineOutcome {
  /** 本次是否真的跑了修复（manifest 改写 + pnpm 安装）。 */
  repaired: boolean
  /** 操作结束时读到的市场实际版本（可读时）。 */
  version?: string
}

function manifestWithMarketPin(manifest: ProfileManifest, spec: string): ProfileManifest {
  const dependencies = { ...manifest.dependencies, [MARKET_PACKAGE]: spec }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const nextBundles = bundles.includes(MARKET_PACKAGE) ? bundles : [...bundles, MARKET_PACKAGE]
  return {
    ...manifest,
    dependencies,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: nextBundles } }
  }
}

/**
 * 启动前对齐市场基线（社区版 `ensureMarketBaseline` 对位）。
 *
 * 快路径只有两三次文件读：没声明市场（用户移除/禁用）→ 不动；已装版本 ≥ 基线且不是
 * generation 链接、也没有未完成标记 → 不动。需要修复时才改写 manifest（钉精确目标）、
 * 撤安装完成标记、跑 `plugin install`，然后**读回实际版本核验**；失败则回滚 manifest 并把
 * 未完成标记留给下次启动重试。调用方必须已停止 Harness——重装会替换共享树里的包。
 */
export async function ensureMarketBaselineWith(options: MarketChannelOptions): Promise<MarketBaselineOutcome> {
  const { io, runner, note } = options
  const paths = marketPaths(options.dshHome)
  const loaded = await readManifest(io, paths)
  if (!loaded) return { repaired: false }
  if (!declaresMarket(loaded.manifest)) return { repaired: false }

  const installed = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  const linked = await isGenerationLink(io, paths)
  const pending = (await io.entryKind(paths.pendingPath)) !== 'missing'
  if (meetsMarketBaseline(installed) && !linked && !pending) {
    return { repaired: false, version: installed }
  }

  const declared = loaded.manifest.dependencies?.[MARKET_PACKAGE]
  const target = selectMarketTargetVersion({ ...(declared ? { declared } : {}), ...(installed ? { installed } : {}) })
  note?.(
    linked
      ? `[market] ${MARKET_PACKAGE} ${installed ?? '(unknown)'} is a link; reinstalling into the shared tree at ${target}`
      : `[market] upgrading ${MARKET_PACKAGE} ${installed ?? '(missing)'} to ${target}`
  )

  await ensurePnpmWorkspaceSettings(io, paths.profileDir)
  await clearProfileInstallMarker(io, paths.profileDir)
  if (!pending) {
    await io.writeText(paths.pendingPath, `${JSON.stringify({ targetVersion: target, at: Date.now() })}\n`)
  }
  try {
    await io.writeText(
      paths.manifestPath,
      `${JSON.stringify(manifestWithMarketPin(loaded.manifest, target), undefined, 2)}\n`
    )
    await runWithRegistryFallback(
      runner,
      profileInstallArgs,
      (registry) => `dsh plugin install ${MARKET_PACKAGE}@${target} (${registry})`,
      note
    )
    // pnpm 退出 0 可能是"什么也没做"——公开 profile 路径上的实际版本才算数。
    const active = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
    if (!meetsMarketBaseline(active)) {
      throw new Error(
        `${MARKET_PACKAGE} installation reported success, but the active version is ${active ?? 'missing'}; requires >=${VERIFIED_MARKET_BASELINE}`
      )
    }
    await io.removeFile(paths.pendingPath)
    return { repaired: true, version: active }
  } catch (error) {
    // pnpm 可能在失败前就换掉了包，所以 manifest 回滚不是"树回滚"——未完成标记仍在，
    // 下次启动会再修一遍（社区版同款取舍）。
    await io.writeText(paths.manifestPath, loaded.raw)
    throw error
  }
}

/**
 * 安装面：把市场装进共享树（社区版首装路径 `buildMarketInstallArguments` 对位）。
 *
 * 顺序有意为之：**先声明再安装**。裸 `add` 失败时若什么都没留下，市场就是永久缺失
 * （启动前修复只在 manifest 声明了它时才动手）；先写声明 + bundle 层，失败也能被下一
 * 次启动的基线修复兜住。
 */
export async function installMarketBundleWith(options: MarketChannelOptions): Promise<{ version?: string }> {
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

  // 装什么版本：首次安装用社区版推荐的 range（那正是他们首装路径的形状）；**已经装着一个
  // 版本**时改取 max(基线, 声明, 已装)——与启动前修复同一条"永不降级"规则。少了这条，
  // 一次"重新安装 dsh"会把用户手上更新的市场按 range 拽回 1.x 的上界。
  const installed = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  const declared = loaded.manifest.dependencies?.[MARKET_PACKAGE]
  const spec =
    installed || declared
      ? selectMarketTargetVersion({ ...(declared ? { declared } : {}), ...(installed ? { installed } : {}) })
      : RECOMMENDED_MARKET_VERSION

  await io.writeText(
    paths.manifestPath,
    `${JSON.stringify(manifestWithMarketPin(loaded.manifest, spec), undefined, 2)}\n`
  )
  await runWithRegistryFallback(
    runner,
    (registry) => marketAddArgs(spec, registry),
    (registry) => `dsh plugin add ${MARKET_PACKAGE}@${spec} (${registry})`,
    note
  )

  const version = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  if (!meetsMarketBaseline(version)) {
    throw new Error(
      `${MARKET_PACKAGE} install reported success, but the active version is ${version ?? 'missing'}; requires >=${VERIFIED_MARKET_BASELINE}`
    )
  }
  return { version }
}

/**
 * 现有市场能否独立撑起这次启动（社区版 `marketUsableWithoutBaseline` 对位）。
 * 只有"缺失 / 不可读 / 仍是 generation 链接"才是否——基装修复失败（常见于受限网络）
 * 不该让用户丢掉本来还能用的 profile。
 */
export async function marketUsableWithoutBaselineWith(io: MarketIo, paths: MarketPaths): Promise<boolean> {
  const marketPath = path.join(paths.nodeModulesDir, MARKET_PACKAGE)
  const kind = await io.entryKind(marketPath)
  if (kind === 'missing') return false
  if (kind === 'link' && ((await io.linkTarget(marketPath))?.includes('.generations') ?? false)) return false
  const version = await readProfileBundleVersion(io, paths.profileDir, MARKET_PACKAGE)
  return !!version && !!parseSemver(version)
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
export function installMarketBundle(): Promise<{ version?: string }> {
  return installMarketBundleWith(defaultMarketOptions())
}

/** 启动前入口（DeepSeekHarnessService 调用）：需要时才修复并核验。 */
export function ensureMarketBaseline(): Promise<MarketBaselineOutcome> {
  return ensureMarketBaselineWith(defaultMarketOptions())
}

/** 现有市场是否仍可加载（修复失败时的降级判据）。 */
export function marketUsableWithoutBaseline(): Promise<boolean> {
  return marketUsableWithoutBaselineWith(nodeMarketIo, marketPaths(deepSeekHarnessHome()))
}
