import { loggerService } from '@logger'
import {
  ClaudePluginsSearchResponseSchema,
  ClawhubSearchResponseSchema,
  type SkillSearchResult,
  type SkillSearchSource,
  SkillsShSearchResponseSchema
} from '@types'

const logger = loggerService.withContext('SkillSearchService')

const CLAUDE_PLUGINS_API = 'https://claude-plugins.dev/api/skills'
const SKILLS_SH_API = 'https://skills.sh/api/search'
const CLAWHUB_API = 'https://clawhub.ai/api/v1/search'

const REQUEST_TIMEOUT_MS = 15_000

// ===========================================================================
// Normalizers: source-specific response → unified SkillSearchResult[]
// ===========================================================================

function normalizeClaudePlugins(raw: unknown): SkillSearchResult[] {
  const parsed = ClaudePluginsSearchResponseSchema.safeParse(raw)
  if (!parsed.success) return []

  return parsed.data.skills.map((s) => {
    const repoOwner = s.metadata?.repoOwner ?? ''
    const repoName = s.metadata?.repoName ?? ''
    const directoryPath = s.metadata?.directoryPath ?? ''
    return {
      slug: s.id,
      name: s.name,
      description: s.description ?? null,
      author: s.author ?? s.namespace ?? null,
      stars: s.stars ?? 0,
      downloads: s.installs ?? 0,
      sourceRegistry: 'claude-plugins.dev' as SkillSearchSource,
      sourceUrl: s.sourceUrl ?? (repoOwner && repoName ? `https://github.com/${repoOwner}/${repoName}` : null),
      // Encode sourceUrl directly so install can clone + resolve without the resolve API
      installSource: `claude-plugins:${repoOwner}/${repoName}/${directoryPath}`
    }
  })
}

function normalizeSkillsSh(raw: unknown): SkillSearchResult[] {
  const parsed = SkillsShSearchResponseSchema.safeParse(raw)
  if (!parsed.success) return []

  return parsed.data.skills.map((s) => ({
    slug: s.id,
    name: s.name,
    description: null,
    author: s.source.split('/')[0] ?? null,
    stars: 0,
    downloads: s.installs,
    sourceRegistry: 'skills.sh' as SkillSearchSource,
    sourceUrl: s.source ? `https://github.com/${s.source}` : null,
    installSource: `skills.sh:${s.id}`
  }))
}

function normalizeClawhub(raw: unknown): SkillSearchResult[] {
  const parsed = ClawhubSearchResponseSchema.safeParse(raw)
  if (!parsed.success) return []

  return parsed.data.results.map((s) => ({
    slug: s.slug,
    name: s.displayName,
    description: s.summary ?? null,
    author: null,
    stars: 0,
    downloads: 0,
    sourceRegistry: 'clawhub.ai' as SkillSearchSource,
    sourceUrl: `https://clawhub.ai/skills/${s.slug}`,
    installSource: `clawhub:${s.slug}`
  }))
}

// ===========================================================================
// Fetch helpers
// ===========================================================================

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetchWithTimeout(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

// ===========================================================================
// Source fetchers
// ===========================================================================

async function searchClaudePlugins(query: string): Promise<SkillSearchResult[]> {
  const url = new URL(CLAUDE_PLUGINS_API)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '20')
  const json = await fetchJson(url.toString())
  return normalizeClaudePlugins(json)
}

async function searchSkillsSh(query: string): Promise<SkillSearchResult[]> {
  const url = new URL(SKILLS_SH_API)
  url.searchParams.set('q', query)
  const json = await fetchJson(url.toString())
  return normalizeSkillsSh(json)
}

async function searchClawhub(query: string): Promise<SkillSearchResult[]> {
  const url = new URL(CLAWHUB_API)
  url.searchParams.set('q', query)
  const json = await fetchJson(url.toString())
  return normalizeClawhub(json)
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * 技能检索结果（二轮审查 r2-07：失败源必须结构化返回）。
 *
 * 旧实现给每个源挂 `.catch(() => [])`，把「源失败」替换成「成功但空」——与「该源确实没有
 * 命中」不可区分，`useSkills.ts` 的 `setError` 永不置位（三个源全断网时界面显示「无结果」，
 * 违反 CLAUDE.md §9「A failure must never look like an empty result」）。
 */
export interface SkillSearchOutcome {
  results: SkillSearchResult[]
  /** 本次检索中失败/不可用的源（有序，便于调用方提示「N 个来源失败」）。 */
  failed: SkillSearchSource[]
}

/** 三个源固定顺序：索引 i 与下方 sources[i] 一一对应（去重键与失败归因都用得到）。 */
const SEARCH_SOURCES: readonly SkillSearchSource[] = ['skills.sh', 'claude-plugins.dev', 'clawhub.ai']

/**
 * Search all 3 skill registries.
 *
 * r2-07 修正两点：
 * 1. 失败按源结构化返回（不再吞成空数组）——调用方可以区分「零命中」与「有源失败」；
 * 2. 去重键改为 `registry + slug`。旧注释写「keep first occurrence = fastest source」是错的
 *    （`Promise.allSettled` 等最慢的源，顺序只由 `sources` 数组决定），而按裸 `name` 去重会把
 *    不同 registry 的同名 skill 当成重复吞掉。
 */
export async function searchSkills(query: string): Promise<SkillSearchOutcome> {
  if (!query.trim()) return { results: [], failed: [] }

  const sources = [searchSkillsSh(query), searchClaudePlugins(query), searchClawhub(query)]

  const settled = await Promise.allSettled(sources)
  const allResults: SkillSearchResult[] = []
  const failed: SkillSearchSource[] = []

  settled.forEach((result, index) => {
    const source = SEARCH_SOURCES[index]
    if (result.status === 'fulfilled') {
      allResults.push(...result.value)
      return
    }
    failed.push(source)
    const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
    logger.warn(`${source} search failed`, { error: error.message })
  })

  // 去重键 = 来源 registry + slug（同名不同源的 skill 是两个可安装的实体，不得互相吞掉）
  const seen = new Set<string>()
  const results = allResults.filter((r) => {
    const key = `${r.sourceRegistry}\u0000${r.slug}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { results, failed }
}
