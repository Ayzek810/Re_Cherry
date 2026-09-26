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
import { cacheRoot, codeMateToolsRoot, nodeRuntimeDir, pythonRuntimeDir } from '@main/services/deepSeekHarness/paths'
import { crossPlatformSpawn } from '@main/utils/processRunner'
import { IpcChannel } from '@shared/IpcChannel'
import { redactSecretText } from '@shared/utils/redaction'

import { type BinaryToolName, type BinaryToolPreset, BINARY_TOOL_PRESETS } from './presets'
import {
  ensureNodeRuntime,
  ensurePythonRuntime,
  isNodeRuntimeInstalled,
  NODE_VERSION,
  PYTHON_VERSION
} from './runtimeDownloader'

const logger = loggerService.withContext('BinaryManager')

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

  /**
   * 主计算的工具快照（V2 getToolSnapshots 形状：application 与 availability 是两个独立
   * 事实）。刻意不取 mutation mutex——慢安装不得隐藏已发布的事实（V2 同款注释语义）。
   */
  async getToolSnapshots(names: readonly string[]): Promise<Record<string, BinaryToolSnapshot>> {
    const snapshots: Record<string, BinaryToolSnapshot> = {}
    for (const name of names) {
      const plan = TOOL_PLANS.get(name)
      if (!plan) {
        snapshots[name] = { name, application: 'absent', availability: { source: 'none' } }
        continue
      }
      snapshots[name] = await this.snapshotTool(plan)
    }
    return snapshots
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

  /** dsh（npm 型）：受管 node → npm install --prefix → requiredPeer 校验 → 版本标记。 */
  private async installNpmTool(plan: ToolPlan): Promise<void> {
    const runtime = await ensureNodeRuntime()
    const dir = toolDir(plan.name)
    await fsp.mkdir(dir, { recursive: true })
    // PATH 首位钉受管 node（npm shim 再启 node 时取它）；缓存钉 CodeMate 子树。
    const pathSep = isWin ? ';' : ':'
    const nodeBinDir = isWin ? runtime.dir : path.join(runtime.dir, 'bin')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${nodeBinDir}${pathSep}${process.env.PATH ?? ''}`,
      npm_config_cache: path.join(cacheRoot(), 'npm'),
      npm_config_registry: NPM_REGISTRY_MIRROR
    }
    await this.runCommand(runtime.npmBin, ['install', '--prefix', dir, `${plan.preset.packageName}@latest`], {
      env,
      label: `npm install ${plan.preset.packageName}`
    })

    const managedPath = managedBinaryPath(plan)
    if (!(await pathExists(managedPath))) {
      throw new Error(
        `npm install finished but ${managedPath} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
    }
    // broken 也算"装了"但标 broken（V2 语义）；快照里据此呈现。
    if (plan.preset.requiredPeer && !this.hasRequiredRuntimeDependencies(plan.name, managedPath)) {
      logger.warn(`Managed tool ${plan.name} installed but its required peer is missing`, {
        ...plan.preset.requiredPeer
      })
    }
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

  /** 卸载（mutex 串行）：删工具目录 + 1:1 映射的运行时目录（node↔dsh、python↔hermes）。 */
  async removeTool(name: BinaryToolName): Promise<BinaryRemoveResult> {
    const plan = TOOL_PLANS.get(name)
    if (!plan) return { removed: false, message: `Unknown managed tool: ${name}` }
    return this.operationMutex.runExclusive(async () => {
      try {
        await fsp.rm(toolDir(plan.name), { recursive: true, force: true })
        // fork 缝：运行时 1:1 映射写死（node↔dsh、python↔hermes；V2 由 mise 统一 prune）。
        const runtimeDir = plan.runtime === 'node' ? nodeRuntimeDir(NODE_VERSION) : pythonRuntimeDir(PYTHON_VERSION)
        await fsp.rm(runtimeDir, { recursive: true, force: true })
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
      const stdout = await this.runCommand(runtime.npmBin, ['view', plan.preset.packageName, 'version'], {
        env: { ...process.env, npm_config_registry: NPM_REGISTRY_MIRROR },
        label: `npm view ${plan.preset.packageName}`,
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
