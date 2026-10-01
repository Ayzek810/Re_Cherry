// fork 缝（原创，v0.4.5）：源码型受管工具的获取原语——GitHub 源码树（codeload）下载、
// 解压归位、pyproject 依赖解析、前端产物部署、用户态播种。
// 设计来源：runtimeDownloader.ts 的下载/解压/重试模式（同盘 rename、.part 先写后改名、
// EPERM/EBUSY 退避——杀软扫描窗口）。
// 与注册表型工具（npm/PyPI）的差别：**无镜像等价物**——任意 GitHub 仓库没有 npmmirror
// 对应物，所以源码获取只可能走 GitHub 本身或**GitHub 加速前缀**。
// v0.4.5-1：加速前缀内置（用户裁决 2026-09-29：`https://ghfast.top/https://github.com`），
// 官方 codeload 作为回退保留；两种 URL 形态都做过实测，见 `DEFAULT_GITHUB_MIRROR` 的注释。
// 取回的内容仍要过"顶层目录名 = <Repo>-<完整 SHA>"校验——它挡的是"代理给了别的提交/别的东西"，
// 但**挡不住**"代理按正确目录名塞了改过的内容"：经第三方加速取源码，等于把该代理放进信任面，
// 这一点由用户裁决接受，不由这里偷偷替用户决定。失败如实上抛（fail-closed，不做假成功）。
// 编排（进度广播、运行时供给、命令执行）留在 BinaryManager.installSourceTool，本文件只
// 提供网络/文件系统/解析原语，便于单测。

import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import StreamZip from 'node-stream-zip'

import { replaceDirectory } from './atomicSwap'
import { downloadFromAnySource, type DownloadProgress } from './downloadFile'

const logger = loggerService.withContext('SourceInstaller')

const API_TIMEOUT_MS = 10_000
const EXTRACT_TIMEOUT_MS = 120_000
/** GitHub API 的源内尝试次数（匿名限流是确定性拒绝，不在此列）。 */
const API_ATTEMPTS = 3
/**
 * SHA 解析结果的短缓存。匿名 GitHub API 只有 60 次/时/IP，而这一条路径会被"检查更新"按钮
 * 反复触发——同一个分支在缓存窗口内重复点按不该重复烧配额。窗口取 60s：跨窗口才可能看到
 * 上游新提交，而检查更新本来就是"现在看一眼"的语义。
 */
const HEAD_SHA_TTL_MS = 60_000
const headShaCache = new Map<string, { sha: string; at: number }>()

/** GitHub API 要求显式 User-Agent（缺省 UA 会被 403）。 */
const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Re_Cherry-CodeMate'
} as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 终态失败：重试没有意义（限流/权限），直接给用户可读原因。 */
class TerminalApiError extends Error {}

// ---------------------------------------------------------------------------
// 上游版本事实：HEAD commit SHA
// ---------------------------------------------------------------------------

/**
 * 解析分支 HEAD 的 commit SHA。这是源码型工具唯一的版本判据——上游
 * Tswoen/Paper-Agent 无任何 tag/release，pyproject 版本号恒定 0.1.0。
 *
 * v0.4.5-1：加了源内重试与限流可言明失败。匿名 GitHub API 是 60 次/时/IP——共享出口下
 * "查不到 SHA"是常态而非异常，旧实现一次失败就把整个安装判死，且原因是英文哑弹。
 */
export async function resolveHeadSha(repo: string, branch: string): Promise<string> {
  const cacheKey = `${repo}@${branch}`
  const cached = headShaCache.get(cacheKey)
  if (cached && Date.now() - cached.at < HEAD_SHA_TTL_MS) return cached.sha

  const failures: string[] = []
  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
        headers: GITHUB_API_HEADERS,
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      })
      if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining')
        throw new TerminalApiError(
          `GitHub API refused the request for ${repo}@${branch} (HTTP ${response.status}` +
            `${remaining !== null ? `, remaining quota ${remaining}` : ''}). ` +
            'Anonymous access allows 60 requests per hour per IP address; retry later or from another network.'
        )
      }
      if (!response.ok) {
        throw new Error(`GitHub API returned HTTP ${response.status} for ${repo}@${branch}`)
      }
      const payload = (await response.json()) as { sha?: unknown }
      if (typeof payload.sha !== 'string' || !/^[0-9a-f]{40}$/.test(payload.sha)) {
        throw new Error(`GitHub API did not return a commit SHA for ${repo}@${branch}`)
      }
      headShaCache.set(cacheKey, { sha: payload.sha, at: Date.now() })
      return payload.sha
    } catch (error) {
      if (error instanceof TerminalApiError) throw error
      failures.push(`attempt ${attempt}/${API_ATTEMPTS}: ${errorMessage(error)}`)
      if (attempt < API_ATTEMPTS) {
        logger.warn(`Failed to resolve ${repo}@${branch}, retrying`, { error: errorMessage(error) })
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
      }
    }
  }
  throw new Error(`Could not resolve ${repo}@${branch}: ${failures.join('; ')}`)
}

// ---------------------------------------------------------------------------
// 源码下载
// ---------------------------------------------------------------------------

/** 官方源码归档主机（GitHub codeload：按 SHA 取，内容固定）。 */
const CODELOAD_ORIGIN = 'https://codeload.github.com'
/** github.com 归档路径的主机；加速前缀作用在**这条** URL 形态上（见下）。 */
const GITHUB_ORIGIN = 'https://github.com'

/**
 * 内置的 GitHub 加速前缀（用户裁决 2026-09-29）。
 *
 * 为什么拼在 github.com 归档路径上、而不是当前的 codeload 形态——**实测**（本机，2026-09-29）：
 *   https://codeload.github.com/<repo>/zip/<sha>                       200 application/zip  1.2s
 *   https://ghfast.top/https://codeload.github.com/<repo>/zip/<sha>    403 text/html（该前缀不吃 codeload 形态）
 *   https://ghfast.top/https://github.com/<repo>/archive/<sha>.zip     200 application/zip  2.9–5.3s
 *   https://github.com/<repo>/archive/<sha>.zip                        fetch failed（本机直连 github.com 不通）
 * 所以前缀语义 = "github.com 之前的那一段"，与 ghfast 的公开用法一致；`<prefix>/<owner>/<repo>/
 * archive/<sha>.zip` 就是可用形态。官方 codeload 作为回退保留（加速服务抖动/下线时安装不至于失败）。
 */
const DEFAULT_GITHUB_MIRROR = 'https://ghfast.top/https://github.com'
/**
 * 覆盖内置加速前缀的环境变量（逗号或空白分隔；`none`/`off` 表示**关闭加速**只用官方）。
 * 例如 RC_GITHUB_MIRROR="https://ghproxy.net/" 走 ghproxy 系（"前缀 + 完整 URL"形态）。
 */
const GITHUB_MIRROR_ENV = 'RC_GITHUB_MIRROR'
/** 关闭加速的取值。 */
const MIRROR_DISABLED = new Set(['none', 'off'])

/** 解析镜像前缀（去空白、去尾部斜杠、去重、忽略非 http(s) 项）。 */
export function parseGithubMirrorPrefixes(raw: string | undefined): string[] {
  if (!raw) return []
  const prefixes = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\/[^\s]+$/i.test(entry))
  return [...new Set(prefixes)]
}

/**
 * 生效的加速前缀：未设环境变量 → 内置（用户裁决）；设为 `none`/`off` → 关闭；否则用环境变量。
 */
export function githubMirrorPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[GITHUB_MIRROR_ENV]?.trim()
  if (!raw) return [DEFAULT_GITHUB_MIRROR]
  if (MIRROR_DISABLED.has(raw.toLowerCase())) return []
  return parseGithubMirrorPrefixes(raw)
}

/**
 * 一个前缀 → 一条加速 URL。两种前缀形态都支持，判据是"前缀里有没有 github.com 这个主机"：
 * - ghfast 系（`https://ghfast.top/https://github.com`）→ 直接接 `<owner>/<repo>/archive/<sha>.zip`；
 * - ghproxy 系（`https://ghproxy.net`）→ 接完整 URL（`<prefix>/https://github.com/...`）。
 */
export function acceleratedArchiveUrl(prefix: string, repo: string, sha: string): string {
  const archivePath = `${repo}/archive/${sha}.zip`
  return /github\.com(\/|$)/i.test(prefix) ? `${prefix}/${archivePath}` : `${prefix}/${GITHUB_ORIGIN}/${archivePath}`
}

/**
 * 源码归档的候选 URL：加速前缀在前（用户要的就是"加速"，否则它只在失败时才生效），
 * 官方 codeload 恒在最后一位当回退。顺序可按需用 `RC_GITHUB_MIRROR` 调整或关闭。
 */
export function sourceArchiveUrls(repo: string, sha: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const official = `${CODELOAD_ORIGIN}/${repo}/zip/${sha}`
  const accelerated = githubMirrorPrefixes(env).map((prefix) => acceleratedArchiveUrl(prefix, repo, sha))
  return [...accelerated, official]
}

/**
 * 按 SHA 下载源码 zip（内容固定，避免"分支在检查后又被推进"的漂移）。
 * v0.4.5-1：走 downloadFile 原语（流式落盘 + 空闲超时 + 断点续传 + 源内重试）——旧实现
 * 对这类第三方/自建网络路径没有重试，抖动一次就整个安装失败；候选源见
 * {@link sourceArchiveUrls}（加速前缀在前、官方 codeload 回退在后）。
 */
export async function downloadSourceZip(
  repo: string,
  sha: string,
  cacheDir: string,
  options: { onProgress?: (progress: DownloadProgress) => void } = {}
): Promise<string> {
  const downloadsDir = path.join(cacheDir, 'downloads')
  await fsp.mkdir(downloadsDir, { recursive: true })
  const destPath = path.join(downloadsDir, `${repo.replace('/', '-')}-${sha}.zip`)
  const urls = sourceArchiveUrls(repo, sha)
  logger.info(`Downloading source tree from ${urls.join(' | ')}`)
  const result = await downloadFromAnySource(urls, destPath, {
    label: `Download ${repo}@${sha.slice(0, 8)}`,
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  return result.path
}

// ---------------------------------------------------------------------------
// 解压 + 顶层前缀剥离
// ---------------------------------------------------------------------------

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  const zip = new StreamZip.async({ file: archivePath })
  try {
    await fsp.mkdir(destDir, { recursive: true })
    await zip.extract(null, destDir)
  } catch (error) {
    throw new Error(`Failed to extract ${path.basename(archivePath)}: ${errorMessage(error)}`)
  } finally {
    await zip.close()
  }
}

/**
 * 归档解压后的顶层目录名：GitHub 固定为 `<RepoName>-<完整 SHA>`。
 * @param sha - 期望的提交（我们钉的那个）。给了就必须精确匹配。
 */
export function selectSourceTreeEntry(entries: readonly string[], repoName: string, sha?: string): string {
  if (entries.length !== 1) {
    throw new Error(
      `Unexpected source archive layout: expected a single "${repoName}" directory, got ${entries.join(', ') || '(empty)'}`
    )
  }
  const [entry] = entries as [string]
  const expected = sha ? `${repoName}-${sha}` : undefined
  if (expected ? entry !== expected : !entry.startsWith(repoName)) {
    // v0.4.5-1（O8）：镜像/代理取回的内容要能被证伪——顶层目录带着我们钉的 SHA，
    // 对不上说明拿到的不是那一个提交（旧版、串档、或被代理换过内容），一律拒绝。
    throw new Error(
      `Unexpected source archive content: expected the directory "${expected ?? `${repoName}-<sha>`}", got "${entry}"`
    )
  }
  return entry
}

/**
 * 把 codeload zip 的源码树归位到 targetDir：zip 顶层是 `<RepoName>-<sha>/` 包裹层
 * （GitHub 固定布局）→ 整体 rename。
 *
 * v0.4.5-1：改走原子替换——旧源码树先留作备份，切换失败就放回去。旧实现是"先删旧树再
 * 改名"，删成功、改名失败（Windows 杀软/占用）就是"源码树没了、工具也起不来"。
 * 同时校验顶层目录名 = `<RepoName>-<sha>`（见 {@link selectSourceTreeEntry}）。
 */
export async function extractSourceTree(
  archivePath: string,
  targetDir: string,
  repoName: string,
  expectedSha?: string
): Promise<void> {
  void EXTRACT_TIMEOUT_MS
  const tempDir = `${targetDir}.tmp-${Date.now()}`
  try {
    await extractZip(archivePath, tempDir)
    const inner = selectSourceTreeEntry(await fsp.readdir(tempDir), repoName, expectedSha)
    const replaced = await replaceDirectory(path.join(tempDir, inner), targetDir)
    if (!replaced) {
      throw new Error(
        `Could not replace the source tree at ${targetDir} (files locked by a running process?); the previous tree was kept`
      )
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// pyproject 依赖解析
// ---------------------------------------------------------------------------

/**
 * 从 pyproject.toml 提取 `[project] dependencies` 的规格串。
 *
 * 为什么不用 `pip install -e .`：上游 pyproject 无 `[build-system]`，且是 flat-layout
 * 多顶层目录（src/ test/ front/），setuptools 自动发现会失败；而运行时 import 由
 * uvicorn `--app-dir` 解析，**项目自身根本不需要可安装**——venv 只需要第三方依赖。
 * 因此直接装依赖数组，避免打包发现这一整类失败。
 *
 * 解析面：只认 `[project]` 表内的 `dependencies`（同名键出现在 `[tool.*]` 等别的表里不是
 * 运行时依赖——宁可不解析让调用方 fail-closed，也不装错东西）。上游每行一条带引号规格；
 * 引号外的行不入表。解析不到任何依赖时调用方会显式报错（上游布局变了应当看得见，而不是
 * 装个空 venv 然后在启动时才炸成 ImportError）。
 */
export function parsePyprojectDependencies(pyprojectText: string): string[] {
  const projectSection = /^[ \t]*\[project\][ \t]*$/m.exec(pyprojectText)
  if (!projectSection) return []
  // 表作用域 = [project] 之后到下一个表头之前。
  const rest = pyprojectText.slice(projectSection.index + projectSection[0].length)
  const nextSection = /^[ \t]*\[/m.exec(rest)
  const scope = nextSection ? rest.slice(0, nextSection.index) : rest
  const match = /^[ \t]*dependencies[ \t]*=[ \t]*\[([\s\S]*?)\]/m.exec(scope)
  if (!match) return []
  const dependencies: string[] = []
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim().replace(/,$/, '').trim()
    const quoted = /^(['"])(.+)\1$/.exec(line)
    if (quoted) {
      const spec = quoted[2].trim()
      if (spec) dependencies.push(spec)
    }
  }
  return dependencies
}

// ---------------------------------------------------------------------------
// 用户态播种与前端产物部署
// ---------------------------------------------------------------------------

/**
 * 用户态根（home）播种：system.yaml 缺省时从上游默认复制一份。model.json 不播种——
 * 它由该工具 Web UI 的系统设置页写入（含密钥），首启为空是正常状态。
 */
export async function seedUserConfig(sourceDir: string, homeDir: string): Promise<void> {
  const targetConfigDir = path.join(homeDir, 'config')
  await fsp.mkdir(targetConfigDir, { recursive: true })
  const targetSystemConfig = path.join(targetConfigDir, 'system.yaml')
  try {
    await fsp.access(targetSystemConfig)
    return
  } catch {
    // 首装或用户删除了默认文件 → 播种上游默认值。
  }
  const sourceSystemConfig = path.join(sourceDir, 'config', 'system.yaml')
  try {
    await fsp.copyFile(sourceSystemConfig, targetSystemConfig)
    logger.info(`Seeded default system.yaml into ${targetSystemConfig}`)
  } catch (error) {
    logger.warn('No upstream system.yaml to seed; the tool falls back to built-in defaults', {
      error: errorMessage(error)
    })
  }
}

/**
 * 把构建好的前端产物复制到用户态根（home/front/dist）——FastAPI 以 cwd 相对路径
 * 伺服 `front/dist`（src/api/app.py `_mount_frontend`），而进程 cwd 是 home（用户态
 * 与源码树分离的关键，见 PaperAgentService）。
 *
 * v0.4.5-1：改走"复制到 staging → 原子替换"。旧实现是"先删 dist 再 cp"，且**丢弃了删除
 * 结果**：删不掉（被杀软/进程占用）时 cp 会覆盖到旧产物之上，新旧 chunk 混杂，而快照仍判
 * applied——用户看到的是"升级成功了但界面还是旧的"。
 */
export async function deployFrontDist(sourceDir: string, homeDir: string): Promise<void> {
  const sourceDist = path.join(sourceDir, 'front', 'dist')
  const targetFrontDir = path.join(homeDir, 'front')
  const targetDist = path.join(targetFrontDir, 'dist')
  try {
    await fsp.access(path.join(sourceDist, 'index.html'))
  } catch {
    throw new Error(`Front-end build produced no index.html at ${sourceDist}`)
  }
  const stagingDist = path.join(targetFrontDir, `dist.new-${Date.now()}`)
  await fsp.mkdir(targetFrontDir, { recursive: true })
  try {
    await fsp.cp(sourceDist, stagingDist, { recursive: true })
    const replaced = await replaceDirectory(stagingDist, targetDist)
    if (!replaced) {
      throw new Error(
        `Could not replace the deployed front-end at ${targetDist} (files locked by a running process?); the previous build was kept`
      )
    }
  } finally {
    await fsp.rm(stagingDist, { recursive: true, force: true }).catch(() => undefined)
  }
}
