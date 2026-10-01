// fork 缝（原创）：PyPI 版本查询的**源表与载荷解析**单点。
//
// 为什么单列一件：旧实现把"两源"写成同一个路径模板拼两个 base
// （`${base}/${name}/json`），于是第二源恒 404——真机取证（2026-09-29，本机直连）：
//   https://pypi.org/pypi/hermes-agent/json                              → 200 application/json（info.version）
//   https://pypi.tuna.tsinghua.edu.cn/pypi/hermes-agent/json              → 404 text/html
//   https://pypi.tuna.tsinghua.edu.cn/simple/hermes-agent/（PEP 691 Accept）→ 200 …simple.v1+json（versions[11]）
// 也就是说"源"与"该源上哪种端点真能取到版本"是一对事实：镜像不实现 JSON API，只实现 simple
// 索引（及其 PEP 691 JSON 表示）。把两者写在一张表里，路径模板不再假装两源同形。
//
// 解析部分是纯函数（不联网、不读 fs），所以"镜像返回 404/HTML/空 versions"这些分支可以单测。

import { compareSemver, parseSemver, type SemverVersion } from './marketBaseline'

/** PEP 691（simple 索引的 JSON 表示）内容协商头；缺它镜像返回 HTML。 */
export const PEP691_ACCEPT = 'application/vnd.pypi.simple.v1+json'

/** 一个源上的取版本端点：URL 按包名拼，响应交给 `read` 解析成版本号。 */
export interface PypiVersionSource {
  /** 日志里的人类可读来源名。 */
  label: string
  url: (packageName: string) => string
  /** 该端点需要的请求头（PEP 691 内容协商）。 */
  headers?: Record<string, string>
  /** 响应 JSON → 版本号；读不出返回 undefined（**不编造**，由调用方换下一个源）。 */
  read: (payload: unknown) => string | undefined
}

/** `/pypi/<name>/json`：`info.version` 就是 PyPI 自己认定的最新版。 */
export function readInfoVersion(payload: unknown): string | undefined {
  const version = (payload as { info?: { version?: unknown } } | null)?.info?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/**
 * simple 索引 JSON 的 `versions[]`（PEP 700）→ 最高版本。
 *
 * 稳定版优先：镜像的 `versions[]` 同时含预发布，直接取最高会把用户推去装 rc（与市场通道
 * `selectCompatibleMarketVersion` 的"稳定优先"是同一条约定）。全部是预发布时才退回取最高。
 */
export function readSimpleVersions(payload: unknown): string | undefined {
  const versions = (payload as { versions?: unknown } | null)?.versions
  if (!Array.isArray(versions)) return undefined
  const parsed = versions
    .filter((version): version is string => typeof version === 'string')
    .map((version) => ({ version, semver: parseSemver(version) }))
    .filter((entry): entry is { version: string; semver: SemverVersion } => entry.semver !== null)
  if (parsed.length === 0) return undefined
  const stable = parsed.filter((entry) => entry.semver.prerelease.length === 0)
  const pool = stable.length > 0 ? stable : parsed
  return pool.reduce((best, entry) => (compareSemver(entry.version, best) > 0 ? entry.version : best), pool[0].version)
}

/**
 * 源表（顺序即优先级）：**镜像在前**（用户裁决 2026-09-29："那肯定是镜像优先啊"），
 * pypi.org 的 JSON API 退到第二位兜底。与安装路径（pip 的 `--index-url` 用清华）同序——
 * "查版本走 A、装包走 B"本身就是两侧可能不同步的来源。每条的端点在编写时都实测可用
 * （见文件头取证）——不要再"两源共用一个路径模板"。
 */
export const PYPI_VERSION_SOURCES: readonly PypiVersionSource[] = [
  {
    label: 'tsinghua mirror',
    url: (name) => `https://pypi.tuna.tsinghua.edu.cn/simple/${name}/`,
    headers: { accept: PEP691_ACCEPT },
    read: readSimpleVersions
  },
  {
    label: 'pypi.org',
    url: (name) => `https://pypi.org/pypi/${name}/json`,
    read: readInfoVersion
  }
]
