import { loggerService } from '@logger'

const logger = loggerService.withContext('BlacklistMatchPattern')

/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：fork src/renderer/src/utils/blacklistMatchPattern.ts）：
 * - 渲染层原件依赖渲染层 store/types，按父代指令在主进程复制同语义实现；
 *   渲染层原件与既有 import 面零改动。
 * - WebSearchState / WebSearchProviderResponse 换成本文件最小结构类型，过滤函数
 *   泛型化以保留结果项形状。
 * - 黑名单输入按内核配置收窄为两路并行：blacklist（订阅源 ublacklist 模式串，走
 *   MatchPatternMap + /regex/，与上游完全同语义）与 excludeDomains（纯域名串，按
 *   hostname 精确/后缀匹配——上游把裸域名当 match pattern 会因解析失败被丢弃，
 *   主进程改为显式域名匹配）。
 * - parseSubscribeContent 为零依赖纯 fetch，保留供订阅黑名单模式串解析复用。
 *
 * MatchPatternMap 部分 MIT License
 *
 * Copyright (c) 2018 iorate
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * https://github.com/iorate/ublacklist
 */

// ublacklist match pattern 核心已收口到 packages/shared/utils/matchPattern.ts（渲染层同源），
// 本文件只保留主进程侧的过滤适配（excludeDomains 域名匹配 + 编译缓存）。
import { MatchPatternMap } from '@shared/utils/matchPattern'

export {
  parseMatchPattern,
  MatchPatternMap,
  type ParsedMatchPattern,
  type MatchPatternMapJSON
} from '@shared/utils/matchPattern'

/** 纯域名串 → hostname 匹配（v0.3.2 批次2 适配：上游裸域名在 MatchPatternMap 里会被丢弃）。 */
function matchesExcludeDomain(hostname: string, domain: string): boolean {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
  if (normalized.length === 0) {
    return false
  }
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

interface CompiledBlacklist {
  regexPatterns: RegExp[]
  patternMap: MatchPatternMap<string>
}

const blacklistCompileCache = new Map<string, CompiledBlacklist>()
const BLACKLIST_CACHE_LIMIT = 32

/** 黑名单规则 → 编译产物（正则 + MatchPatternMap），按规则串签名缓存（LRU 上限 32）。 */
function getCompiledBlacklist(blacklistPatterns: string[]): CompiledBlacklist {
  const key = blacklistPatterns.join('\n')
  const cached = blacklistCompileCache.get(key)
  if (cached) {
    // 触碰即重插，维持 LRU 语义
    blacklistCompileCache.delete(key)
    blacklistCompileCache.set(key, cached)
    return cached
  }

  // 分类处理黑名单规则（/regex/ → 正则，其余按 match pattern）
  const patternMap = new MatchPatternMap<string>()
  const regexPatterns: RegExp[] = []
  blacklistPatterns.forEach((pattern) => {
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      // 处理正则表达式格式
      try {
        const regexPattern = pattern.slice(1, -1)
        regexPatterns.push(new RegExp(regexPattern, 'i'))
      } catch (error) {
        logger.error(`Invalid regex pattern: ${pattern}`, error as Error)
      }
    } else {
      // 处理匹配模式格式
      try {
        patternMap.set(pattern, pattern)
      } catch (error) {
        logger.error(`Invalid match pattern: ${pattern}`, error as Error)
      }
    }
  })

  const compiled: CompiledBlacklist = { regexPatterns, patternMap }
  blacklistCompileCache.set(key, compiled)
  while (blacklistCompileCache.size > BLACKLIST_CACHE_LIMIT) {
    const oldest = blacklistCompileCache.keys().next().value
    if (oldest === undefined) break
    blacklistCompileCache.delete(oldest)
  }
  return compiled
}

/**
 * 黑名单过滤（上游 filterResultWithBlacklist 同语义的两路并行版）：
 * - options.blacklist：ublacklist 模式串（<all_urls> / scheme://host/path / /regex/）。
 * - options.excludeDomains：纯域名串，hostname 精确或子域后缀命中即排除。
 * 任一路命中即排除该结果；URL 解析失败时保留该结果（与上游一致）。
 */
export async function filterResultWithBlacklist<T extends { url: string }>(
  response: { query?: string; results: T[] },
  options: { blacklist?: string[]; excludeDomains?: string[] }
): Promise<{ query?: string; results: T[] }> {
  logger.debug('[filterResultWithBlacklist]', response)

  const blacklistPatterns = options.blacklist ?? []
  const excludeDomains = options.excludeDomains ?? []

  // 没有结果或者没有黑名单规则时，直接返回原始结果
  if (!response.results?.length || (blacklistPatterns.length === 0 && excludeDomains.length === 0)) {
    return response
  }

  // 编译产物按规则串缓存：黑名单在一次会话内基本不变，而此函数每次搜索请求都会被
  // 调用，逐次 new RegExp + 重建 MatchPatternMap 是纯浪费。
  const compiled = getCompiledBlacklist(blacklistPatterns)
  const { regexPatterns, patternMap } = compiled

  // 过滤搜索结果
  const filteredResults = response.results.filter((result) => {
    try {
      const url = new URL(result.url)

      // 检查URL是否匹配任何正则表达式规则
      const matchesRegex = regexPatterns.some((regex) => regex.test(url.hostname))
      if (matchesRegex) {
        return false
      }

      // 检查URL是否命中任何排除域（纯域名串）
      if (excludeDomains.some((domain) => matchesExcludeDomain(url.hostname, domain))) {
        return false
      }

      // 检查URL是否匹配任何匹配模式规则
      const matchesPattern = patternMap.get(result.url).length > 0
      return !matchesPattern
    } catch (error) {
      logger.error(`Error processing URL: ${result.url}`, error as Error)
      return true // 如果URL解析失败，保留该结果
    }
  })

  logger.debug('filterResultWithBlacklist filtered results:', filteredResults)

  return {
    ...response,
    results: filteredResults
  }
}
