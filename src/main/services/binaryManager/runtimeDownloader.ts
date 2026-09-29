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
import type { InstallProgressStep } from '@shared/types/installProgress'

import { replaceDirectory } from './atomicSwap'
import { type DownloadProgress, downloadFromAnySource } from './downloadFile'

const logger = loggerService.withContext('RuntimeDownloader')

const execFileAsync = promisify(execFile)

/** 解压预算（下载预算已由 downloadFile 的空闲/总时长上限接管）。 */
const EXTRACT_TIMEOUT_MS = 120_000

// 顶部可调：真实存在的 node 发行版与 python-build-standalone tag/版本。
// 批次5 真机事故修复：node dist 布局是 /dist/v{版本}/<文件名>（带 v 前缀的版本目录）——
// 原实现漏掉版本目录段，双源 404（真机日志：nodejs.org 与 npmmirror 均 404）。
// v0.3.4-2 升版 24.9.0（社区桌面壳捆绑的同款版本）——三个理由：
// ① dsh 0.1.5-rc.x 的 bin.js 入口守护 `if (import.meta.main)` 在 Node 22.12.0 下恒为
//    undefined（实测：22.12 输出 undefined、24.19 输出 true）→ CLI 全体静默空转 exit 0
//    （harness 372ms 退出、plugin add 无副作用，全由此起）；
// ② 安装 ABI = 运行 ABI（原生模块 sharp 等不再跨 ABI）；
// ③ PPT bundle engines ^22.19||>=24。
// URL 实测 200（2026-09-26）：
//   https://nodejs.org/dist/v24.9.0/node-v24.9.0-win-x64.zip
//   https://registry.npmmirror.com/-/binary/node/v24.9.0/node-v24.9.0-win-x64.zip
export const NODE_VERSION = '24.9.0'
export const PYTHON_TAG = '20241016'
export const PYTHON_VERSION = '3.12.7'

/**
 * node dist 双源（版本目录段在调用处拼入——base 不含版本段）。
 *
 * v0.4.5-1（用户裁决 2026-09-29）：**npmmirror 提为第一顺位**。原顺序（官方在前）在墙内每次
 * 都要先把官方源失败一遍才轮到镜像：python 那条本机实测官方源 `fetch failed` 花了 **29.6s**
 * 才认输（见下），node 官方源则只是略慢（919ms vs 镜像 681ms）。两台源都实测伺服同一份文件
 * （node：两边 total 均为 36 405 077 字节），所以顺序只影响"多久拿到"，不影响"拿到什么"。
 * 官方源保留在第二位：墙外环境里它才是规范源。
 */
const NODE_DIST_BASES = ['https://registry.npmmirror.com/-/binary/node/', 'https://nodejs.org/dist/'] as const
/**
 * CPython（python-build-standalone）双源，顺序同 node：镜像在前、GitHub Releases 在后。
 * 本机实测（2026-09-29，Range 探测）：
 *   https://github.com/astral-sh/python-build-standalone/releases/download/20241016/<file>  FAIL 29574ms
 *   https://registry.npmmirror.com/-/binary/python-build-standalone/20241016/<file>          206 38116958 字节 520ms
 */
const PYTHON_DIST_BASES = [
  `https://registry.npmmirror.com/-/binary/python-build-standalone/${PYTHON_TAG}/`,
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_TAG}/`
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
// 下载（v0.4.5-1：统一走 downloadFile 原语——流式落盘 + 空闲超时 + 断点续传 + 源内重试）
// ---------------------------------------------------------------------------

export interface RuntimeDownloadOptions {
  /** 字节进度（安装进度条的数据源）；缺省只写日志。 */
  onProgress?: (progress: DownloadProgress) => void
  /**
   * 阶段切换（v0.4.5-1）：下载完成、开始解压时上报 `extract`。
   * 为什么需要：解压 node 的上万文件 / CPython 的 tar 要几十秒，而下载比例此时停在 100%
   * ——不换阶段的话进度条会**冻在 100%**，看着像装完了其实没有（三家工具都有这个阶段）。
   */
  onStep?: (step: InstallProgressStep) => void
}

async function downloadArchive(
  fileName: string,
  bases: readonly string[],
  options: RuntimeDownloadOptions
): Promise<string> {
  const downloadsDir = path.join(cacheRoot(), 'downloads')
  await fsp.mkdir(downloadsDir, { recursive: true })
  const destPath = path.join(downloadsDir, fileName)
  // 双源：主源（npmmirror）/备用源（官方），源内各自续传与重试。
  const urls = bases.map((base) => `${base}${fileName}`)
  logger.info(`Downloading managed runtime: ${urls.join(' | ')}`)
  const result = await downloadFromAnySource(urls, destPath, {
    label: `Download ${fileName}`,
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  return result.path
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
 * rename；python install_only 无包裹层 → 临时目录整体 rename。
 * v0.4.5-1：改走原子替换（atomicSwap）——旧运行时目录先留作备份，切换失败时放回去，
 * 不再"先删旧的再改名"（那形态下改名一失败，运行时目录就半删了）。
 */
async function flattenIntoTarget(tempDir: string, targetDir: string, innerPrefix: string | undefined): Promise<void> {
  let source = tempDir
  if (innerPrefix) {
    const entries = await fsp.readdir(tempDir)
    const inner = entries.find((entry) => entry.startsWith(innerPrefix))
    if (!inner || entries.length !== 1) {
      throw new Error(
        `Unexpected archive layout: expected a single "${innerPrefix}*" directory, got ${entries.join(', ') || '(empty)'}`
      )
    }
    source = path.join(tempDir, inner)
  }
  const replaced = await replaceDirectory(source, targetDir)
  if (!replaced) {
    throw new Error(
      `Could not replace the managed runtime at ${targetDir} (files locked by a running process?); the previous runtime was kept`
    )
  }
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

async function isRuntimeReady(
  dir: string,
  expectedVersion: string,
  requiredFiles: readonly string[]
): Promise<boolean> {
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
export async function ensureNodeRuntime(options: RuntimeDownloadOptions = {}): Promise<NodeRuntime> {
  const dir = nodeRuntimeDir(NODE_VERSION)
  const nodeBin = isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
  const npmBin = isWin ? path.join(dir, 'npm.cmd') : path.join(dir, 'bin', 'npm')
  if (await isRuntimeReady(dir, NODE_VERSION, [nodeBin, npmBin])) return { dir, npmBin, nodeBin }

  const fileName = nodeArchiveName()
  // 版本目录段：node dist 布局 /dist/v{版本}/<文件名>（官方与 npmmirror 同构）。
  const bases = NODE_DIST_BASES.map((base) => `${base}v${NODE_VERSION}/`)
  const archivePath = await downloadArchive(fileName, bases, options)
  const tempDir = `${dir}.tmp-${Date.now()}`
  try {
    options.onStep?.('extract')
    await extractZip(archivePath, tempDir)
    await flattenIntoTarget(tempDir, dir, `node-v${NODE_VERSION}-`)
    await fsp.writeFile(path.join(dir, RUNTIME_VERSION_MARKER), NODE_VERSION, 'utf-8')
    const missing = await firstMissing([nodeBin, npmBin])
    if (missing) {
      throw new Error(
        `Node runtime installed but ${missing} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
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
export async function ensurePythonRuntime(options: RuntimeDownloadOptions = {}): Promise<{ pythonBin: string }> {
  const dir = pythonRuntimeDir(PYTHON_VERSION)
  const pythonBin = isWin ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python3')
  if (await isRuntimeReady(dir, PYTHON_VERSION, [pythonBin])) return { pythonBin }

  const fileName = pythonArchiveName()
  const archivePath = await downloadArchive(fileName, PYTHON_DIST_BASES, options)
  const tempDir = `${dir}.tmp-${Date.now()}`
  try {
    options.onStep?.('extract')
    await extractTarGz(archivePath, tempDir)
    // install_only 布局：所有条目在顶层 `python/` 目录下（三平台同构，与 node 的
    // node-v{v}-* 前缀层同类）——批次2 规格误写"无包裹层"，真机安装必败（真机事故，
    // 见 v0.3.4_doc.md §3）；python.exe 实际位于 {temp}/python/python.exe。
    await flattenIntoTarget(tempDir, dir, 'python')
    await fsp.writeFile(path.join(dir, RUNTIME_VERSION_MARKER), PYTHON_VERSION, 'utf-8')
    const missing = await firstMissing([pythonBin])
    if (missing) {
      throw new Error(
        `Python runtime installed but ${missing} is missing; ${dir} contains: ${await listDirForDiagnostics(dir)}`
      )
    }
    return { pythonBin }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rm(archivePath, { force: true }).catch(() => undefined)
  }
}
