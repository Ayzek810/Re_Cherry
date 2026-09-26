// fork 缝（原创）：V2 为 mise 驱动，本件为 portable 等价实现。
// 设计来源：V2 binaryManager/pythonRuntime.ts（python-build-standalone 官方源 + npmmirror
// 镜像的双源降级、install_only 布局、受管运行时自管思想）+ 勘查报告的 node dist 等价结论；
// 下载/解压按 portable 布局全新实现（V2 由 uv 内置 checksums 校验，fork 简化为不校验——
// 镜像信任面与 V2 的 npmmirror 一致）。解压：Windows zip 用 node-stream-zip（BackupManager
// 同款 API），.tar.gz 用系统 bsdtar（Win10 1803+ 自带）；Unix 一律 tar。

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import StreamZip from 'node-stream-zip'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { cacheRoot, nodeRuntimeDir, pythonRuntimeDir } from '@main/services/deepSeekHarness/paths'

const logger = loggerService.withContext('RuntimeDownloader')

const execFileAsync = promisify(execFile)

/** 单源下载超时；两个源按序尝试，总预算 = 2×该值。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
const EXTRACT_TIMEOUT_MS = 120_000

// 顶部可调：真实存在的 node 发行版与 python-build-standalone tag/版本。
// 批次5 真机事故修复：node dist 布局是 /dist/v{版本}/<文件名>（带 v 前缀的版本目录）——
// 原实现漏掉版本目录段，双源 404（真机日志：nodejs.org 与 npmmirror 均 404）。
// 三个 URL 已实测 200（2026-09-24）：
//   https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip
//   https://registry.npmmirror.com/-/binary/node/v22.12.0/node-v22.12.0-win-x64.zip
//   https://registry.npmmirror.com/-/binary/python-build-standalone/20241016/cpython-3.12.7+20241016-x86_64-pc-windows-msvc-install_only.tar.gz
export const NODE_VERSION = '22.12.0'
export const PYTHON_TAG = '20241016'
export const PYTHON_VERSION = '3.12.7'

/** node dist 双源（版本目录段在调用处拼入——base 不含版本段）。 */
const NODE_DIST_BASES = ['https://nodejs.org/dist/', 'https://registry.npmmirror.com/-/binary/node/'] as const
const PYTHON_DIST_BASES = [
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/`,
  `https://registry.npmmirror.com/-/binary/python-build-standalone/${PYTHON_TAG}/`
] as const

const RUNTIME_VERSION_MARKER = '.codemate-runtime-version'

export interface NodeRuntime {
  dir: string
  npmBin: string
  nodeBin: string
}

// ---------------------------------------------------------------------------
// 文件名组装（process.platform / process.arch → 官方命名）
// ---------------------------------------------------------------------------

function nodeArchiveName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  switch (process.platform) {
    case 'win32':
      return `node-v${NODE_VERSION}-win-${arch}.zip`
    case 'darwin':
      return `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`
    case 'linux':
      return `node-v${NODE_VERSION}-linux-${arch}.tar.gz`
    default:
      throw new Error(`Managed node runtime does not support platform "${process.platform}"`)
  }
}

/** python-build-standalone 的 target triple（win-arm64 亦为 pbs 真实发布的 triple）。 */
function pythonTriple(): string {
  switch (process.platform) {
    case 'win32':
      return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    case 'darwin':
      return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    case 'linux':
      return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
    default:
      throw new Error(`Managed python runtime does not support platform "${process.platform}"`)
  }
}

function pythonArchiveName(): string {
  return `cpython-${PYTHON_VERSION}+${PYTHON_TAG}-${pythonTriple()}-install_only.tar.gz`
}

// ---------------------------------------------------------------------------
// 下载（fetch + .part 先写后改名 + 双源降级）
// ---------------------------------------------------------------------------

async function downloadArchive(fileName: string, bases: readonly string[]): Promise<string> {
  const downloadsDir = path.join(cacheRoot(), 'downloads')
  await fsp.mkdir(downloadsDir, { recursive: true })
  const destPath = path.join(downloadsDir, fileName)
  const partPath = `${destPath}.part`
  const failures: string[] = []
  for (const base of bases) {
    const url = `${base}${fileName}`
    try {
      logger.info(`Downloading managed runtime from ${url}`)
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
      }
      await fsp.writeFile(partPath, Buffer.from(await response.arrayBuffer()))
      await fsp.rename(partPath, destPath)
      return destPath
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // ASCII 箭头：→ 会被 GBK 控制台啃成乱码（真机日志取证）。
      failures.push(`${base} -> ${message}`)
      logger.warn('Runtime download failed, falling back to the next source', { url, error: message })
      await fsp.rm(partPath, { force: true }).catch(() => undefined)
    }
  }
  throw new Error(`Failed to download ${fileName}:\n${failures.join('\n')}`)
}

// ---------------------------------------------------------------------------
// 解压 + 内层目录归位
// ---------------------------------------------------------------------------

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true })
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], {
      timeout: EXTRACT_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // fork 缝：Windows 依赖系统自带 bsdtar（Win10 1803+），老系统没有 tar.exe 或不解 .tar.gz。
    const hint = isWin ? ' (Windows requires the bundled bsdtar: Windows 10 1803 or newer)' : ''
    throw new Error(`Failed to extract ${path.basename(archivePath)}${hint}: ${message}`)
  }
}

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  const zip = new StreamZip.async({ file: archivePath })
  try {
    await fsp.mkdir(destDir, { recursive: true })
    await zip.extract(null, destDir)
  } finally {
    await zip.close()
  }
}

/**
 * 把解压产物归位到 targetDir：node 系档案带 `node-v{v}-*` 前缀层 → 内层目录整体
 * rename；python install_only 无包裹层 → 临时目录整体 rename。rename 前清掉目标
 * （半成品重装），临时目录与目标同盘故 rename 恒可用。
 */
async function flattenIntoTarget(tempDir: string, targetDir: string, innerPrefix: string | undefined): Promise<void> {
  let source = tempDir
  if (innerPrefix) {
    const entries = await fsp.readdir(tempDir)
    const inner = entries.find((entry) => entry.startsWith(innerPrefix))
    if (!inner || entries.length !== 1) {
      throw new Error(`Unexpected archive layout: expected a single "${innerPrefix}*" directory, got ${entries.join(', ') || '(empty)'}`)
    }
    source = path.join(tempDir, inner)
  }
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(targetDir), { recursive: true })
  await fsp.rename(source, targetDir)
  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 幂等性：标记文件 + 关键二进制存在性
// ---------------------------------------------------------------------------

async function readRuntimeMarker(dir: string): Promise<string | undefined> {
  try {
    return (await fsp.readFile(path.join(dir, RUNTIME_VERSION_MARKER), 'utf-8')).trim()
  } catch {
    return undefined
  }
}

async function firstMissing(files: readonly string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      await fsp.access(file)
    } catch {
      return file
    }
  }
  return undefined
}

async function isRuntimeReady(dir: string, expectedVersion: string, requiredFiles: readonly string[]): Promise<boolean> {
  return (await readRuntimeMarker(dir)) === expectedVersion && (await firstMissing(requiredFiles)) === undefined
}

async function listDirForDiagnostics(dir: string): Promise<string> {
  try {
    return (await fsp.readdir(dir)).join(', ') || '(empty)'
  } catch {
    return '(unreadable)'
  }
}

// ---------------------------------------------------------------------------
// 两个运行时获取器
// ---------------------------------------------------------------------------

/** 受管 node 运行时（dsh 的 npm 需要）；已装且版本匹配 → 直接返回（幂等）。 */
export async function ensureNodeRuntime(): Promise<NodeRuntime> {
  const dir = nodeRuntimeDir(NODE_VERSION)
  const nodeBin = isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
  const npmBin = isWin ? path.join(dir, 'npm.cmd') : path.join(dir, 'bin', 'npm')
  if (await isRuntimeReady(dir, NODE_VERSION, [nodeBin, npmBin])) return { dir, npmBin, nodeBin }

  const fileName = nodeArchiveName()
  // 版本目录段：node dist 布局 /dist/v{版本}/<文件名>（官方与 npmmirror 同构）。
  const bases = NODE_DIST_BASES.map((base) => `${base}v${NODE_VERSION}/`)
  const archivePath = await downloadArchive(fileName, bases)
  const tempDir = `${dir}.tmp-${Date.now()}`
  try {
    await extractZip(archivePath, tempDir)
    await flattenIntoTarget(tempDir, dir, `node-v${NODE_VERSION}-`)
    await fsp.writeFile(path.join(dir, RUNTIME_VERSION_MARKER), NODE_VERSION, 'utf-8')
    const missing = await firstMissing([nodeBin, npmBin])
    if (missing) {
      throw new Error(`Node runtime installed but ${missing} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`)
    }
    return { dir, npmBin, nodeBin }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rm(archivePath, { force: true }).catch(() => undefined)
  }
}

/** 受管 node 运行时是否已装可用（npm 类查询的前置条件，不触发下载）。 */
export async function isNodeRuntimeInstalled(): Promise<boolean> {
  const dir = nodeRuntimeDir(NODE_VERSION)
  const nodeBin = isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
  return isRuntimeReady(dir, NODE_VERSION, [nodeBin])
}

/** 受管 CPython 运行时（hermes 的 venv 需要）；已装且版本匹配 → 直接返回（幂等）。 */
export async function ensurePythonRuntime(): Promise<{ pythonBin: string }> {
  const dir = pythonRuntimeDir(PYTHON_VERSION)
  const pythonBin = isWin ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python3')
  if (await isRuntimeReady(dir, PYTHON_VERSION, [pythonBin])) return { pythonBin }

  const fileName = pythonArchiveName()
  const archivePath = await downloadArchive(fileName, PYTHON_DIST_BASES)
  const tempDir = `${dir}.tmp-${Date.now()}`
  try {
    await extractTarGz(archivePath, tempDir)
    // install_only 布局：所有条目在顶层 `python/` 目录下（三平台同构，与 node 的
    // node-v{v}-* 前缀层同类）——批次2 规格误写"无包裹层"，真机安装必败（真机事故，
    // 见 v0.3.4_doc.md §3）；python.exe 实际位于 {temp}/python/python.exe。
    await flattenIntoTarget(tempDir, dir, 'python')
    await fsp.writeFile(path.join(dir, RUNTIME_VERSION_MARKER), PYTHON_VERSION, 'utf-8')
    const missing = await firstMissing([pythonBin])
    if (missing) {
      throw new Error(`Python runtime installed but ${missing} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`)
    }
    return { pythonBin }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rm(archivePath, { force: true }).catch(() => undefined)
  }
}
