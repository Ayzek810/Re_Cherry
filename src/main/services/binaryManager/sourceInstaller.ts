// fork 缝（原创，v0.4.5）：源码型受管工具的获取原语——GitHub 源码树（codeload）下载、
// 解压归位、pyproject 依赖解析、前端产物部署、用户态播种。
// 设计来源：runtimeDownloader.ts 的下载/解压/重试模式（同盘 rename、.part 先写后改名、
// EPERM/EBUSY 退避——杀软扫描窗口）。
// 与注册表型工具（npm/PyPI）的差别：**无镜像等价物**——任意 GitHub 仓库没有 npmmirror
// 对应物。v0.4.5-1（O8，用户裁决"可引"）：官方 codeload 之外支持**用户配置的镜像前缀**
// （`RC_GITHUB_MIRROR`，官方恒第一顺位），并且镜像取回的内容要过"顶层目录名 = <Repo>-<完整
// SHA>"校验——第三方代理因此无法把别的提交塞进来。默认不带任何镜像：这条链路下的是源码，
// 随后会被编译并与其依赖树一起运行，信任面不该由一个内置常量替用户决定。
// 失败如实上抛（fail-closed，不做假成功）。
// 编排（进度广播、运行时供给、命令执行）留在 BinaryManager.installSourceTool，本文件只
// 提供网络/文件系统/解析原语，便于单测。

import fsp from 'node:fs/promises'
import path from 'node:path'

import StreamZip from 'node-stream-zip'

import { loggerService } from '@logger'

import { replaceDirectory } from './atomicSwap'
import { type DownloadProgress, downloadFromAnySource } from './downloadFile'

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
/**
 * 源码归档的**镜像前缀**环境变量（v0.4.5-1 / O8，用户裁决"可引"）。
 *
 * 为什么是 opt-in 而不是内置几个公共代理：这条链路下的是**源码**，随后被 `vite build` 编译、
 * 被 `pip install` 的依赖树一起运行——经第三方代理取源码等于把该代理放进信任面。运行时的
 * node/python 档案走 npmmirror 是既有裁决，源码不该被同一句话顺带覆盖。
 *
 * 用法：逗号或空白分隔的**前缀**（会拼在官方 URL 前面），例如
 *   RC_GITHUB_MIRROR="https://ghproxy.net/,https://ghfast.top/"
 * 官方主机恒为第一顺位，仅在它失败后才逐个尝试镜像；镜像取到的归档还要过下面的
 * "顶层目录名 = <Repo>-<完整 SHA>"校验（SHA 是我们自己钉的，代理换了内容就对不上）。
 */
const GITHUB_MIRROR_ENV = 'RC_GITHUB_MIRROR'

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
 * 源码归档的候选 URL（官方在前，配置的镜像在后）。镜像前缀拼在完整官方 URL 之前
 * （ghproxy 系代理的约定形态：`<prefix>/<原始 URL>`）。
 */
export function sourceArchiveUrls(repo: string, sha: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const official = `${CODELOAD_ORIGIN}/${repo}/zip/${sha}`
  const mirrors = parseGithubMirrorPrefixes(env[GITHUB_MIRROR_ENV]).map((prefix) => `${prefix}/${official}`)
  return [official, ...mirrors]
}

/**
 * 按 SHA 下载源码 zip（codeload：内容固定，避免"分支在检查后又被推进"的漂移）。
 * v0.4.5-1：走 downloadFile 原语（流式落盘 + 空闲超时 + 断点续传 + 源内重试）——旧实现
 * 对这类第三方/自建网络路径没有重试，抖动一次就整个安装失败；官方主机之外再补配置的镜像
 * （见 {@link sourceArchiveUrls}，默认只有官方）。
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
