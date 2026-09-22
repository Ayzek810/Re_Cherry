/**
 * v0.3.2 批次2 自 CS_V1 移植 + 适配点清单（源：上游
 * src/renderer/src/providers/WebSearchProvider/{LocalGoogleProvider,LocalBingProvider,LocalBaiduProvider}.ts）。
 *
 * - 主进程无 DOM：上游三引擎的 DOM 解析查询改为正则/字符串扫描等价实现，
 *   每引擎一个独立小函数，函数注释标注对应的上游选择器与字段抽取语义。
 * - 纯函数、零 import（无 DOM 解析 / 无第三方依赖），渲染层与主进程均可用。
 * - 上游三引擎只抽 {title, url}（content 由后续 fetchWebContent 抓取），本模块
 *   输出形态统一为 {title, url, content}，content 恒为 ''。
 * - href 适配：Google 的 /url?q= 跟踪链接解出真实 URL（规则 d 点名）；Bing 的
 *   /ck/a?...&u=a1<base64> 重定向解码（上游 decodeBingUrl 同语义）；Baidu 保持
 *   href 原样（上游即原样透传，真实 URL 由后续抓取跟随重定向得到）。
 * - 补充按 URL 去重（正则扫描可能对同一结果块重复命中；上游 DOM 遍历天然无重）。
 * - 条数上限不做在解析器（上游由 provider 按最大结果数切片），调用方自行 slice。
 */

export type SearchEngineId = 'google' | 'bing' | 'baidu'

export type ParsedSearchResult = {
  title: string
  url: string
  content: string
}

export function parseSearchResults(html: string, engine: SearchEngineId): ParsedSearchResult[] {
  switch (engine) {
    case 'google':
      return parseGoogle(html)
    case 'bing':
      return parseBing(html)
    case 'baidu':
      return parseBaidu(html)
  }
}

// ---------------------------------------------------------------------------
// 通用扫描辅助
// ---------------------------------------------------------------------------

/** 尽量把扫描范围收窄到结果容器内（容器标记缺失时回退全文，页面改版容错）。 */
function sliceRegion(html: string, containerRegExp: RegExp): string {
  const match = containerRegExp.exec(html)
  return match ? html.slice(match.index) : html
}

/** 解码常见命名实体与数字实体（上游 DOM 解析的 textContent / href 属性会自动解码）。 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code)
      }
      return match
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** 去标签 + 实体解码 + 空白折叠，得到标题纯文本（上游为元素的 textContent）。 */
function extractText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从开始标签里取属性值（兼容双引号 / 单引号 / 无引号三种形态）。 */
function extractAttr(openTag: string, attr: string): string | null {
  const regExp = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = regExp.exec(openTag)
  if (!match) {
    return null
  }
  const value = match[1] ?? match[2] ?? match[3]
  return value === undefined ? null : decodeHtmlEntities(value)
}

type AnchorInfo = {
  href: string
  innerHtml: string
}

/** 逐个扫描 <a ...> ... </a> 标签对，取 href 属性与标签内 HTML。 */
function collectAnchors(html: string): AnchorInfo[] {
  const anchors: AnchorInfo[] = []
  const regExp = /(<a\s[^>]*>)([\s\S]*?)<\/a\s*>/gi
  let match: RegExpExecArray | null
  while ((match = regExp.exec(html)) !== null) {
    const href = extractAttr(match[1], 'href')
    if (href === null || href.length === 0) {
      continue
    }
    anchors.push({ href, innerHtml: match[2] })
  }
  return anchors
}

/**
 * 逐对扫描 `<tag ...> ... </tag>`（tag 为 h2/h3 等），在每对内部再找锚点。
 * 对应上游 `doc.querySelectorAll('#b_results h2')` / `'#content_left .result h3'`
 * 后在每个条目里 `querySelector('a')` 的语义（标题元素包住锚点的形态）。
 */
function collectTaggedAnchors(html: string, tag: string): AnchorInfo[] {
  const anchors: AnchorInfo[] = []
  const regExp = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regExp.exec(html)) !== null) {
    const inner = match[1]
    const anchorRegExp = /(<a\s[^>]*>)([\s\S]*?)<\/a\s*>/i
    const anchorMatch = anchorRegExp.exec(inner)
    if (!anchorMatch) {
      continue
    }
    const href = extractAttr(anchorMatch[1], 'href')
    if (href === null || href.length === 0) {
      continue
    }
    anchors.push({ href, innerHtml: anchorMatch[2] })
  }
  return anchors
}

/** 锚点 → 结果项；title 取锚点文本（无则空串），去重交给调用前的 collect 差异。 */
function toResult(anchor: AnchorInfo, href: string): ParsedSearchResult {
  return {
    title: extractText(anchor.innerHtml),
    url: href,
    content: ''
  }
}

/** 按 URL 去重（保持首次出现顺序）。 */
function dedupeByUrl(results: ParsedSearchResult[]): ParsedSearchResult[] {
  const seen = new Set<string>()
  const unique: ParsedSearchResult[] = []
  for (const result of results) {
    if (result.url.length === 0 || seen.has(result.url)) {
      continue
    }
    seen.add(result.url)
    unique.push(result)
  }
  return unique
}

// ---------------------------------------------------------------------------
// Google —— 上游 LocalGoogleProvider：'#search .MjjYud' 块内取 h3 的 textContent
// 与首个 a 的 href（h3 与 a 同块即可，不要求嵌套）。
// ---------------------------------------------------------------------------

function parseGoogle(html: string): ParsedSearchResult[] {
  const region = sliceRegion(html, /<div[^>]*id="search"/i)
  const results: ParsedSearchResult[] = []

  // 形态 A：<a href=...> ... <h3>标题</h3> ... </a>（锚点包住 h3）
  for (const anchor of collectAnchors(region)) {
    if (!/<h3[\s>]/i.test(anchor.innerHtml)) {
      continue
    }
    const h3Match = /<h3[^>]*>([\s\S]*?)<\/h3\s*>/i.exec(anchor.innerHtml)
    const title = extractText(h3Match ? h3Match[1] : anchor.innerHtml)
    results.push({ title, url: normalizeGoogleHref(anchor.href), content: '' })
  }

  // 形态 B：<h3 ...><a href=...>标题</a></h3>（h3 包住锚点）
  for (const anchor of collectTaggedAnchors(region, 'h3')) {
    results.push(toResult(anchor, normalizeGoogleHref(anchor.href)))
  }

  return dedupeByUrl(results)
}

/** Google 跟踪链接 '/url?q=<encoded>' / 'https://www.google.com/url?q=...' 解出真实 URL。 */
function normalizeGoogleHref(href: string): string {
  try {
    const url = href.startsWith('/') ? new URL(href, 'https://www.google.com') : new URL(href)
    if (url.pathname === '/url') {
      const target = url.searchParams.get('q') ?? url.searchParams.get('url')
      if (target) {
        return target
      }
    }
  } catch {
    // 非法 URL 保持原值（后续由 provider 的 http(s) 前缀过滤兜住）
  }
  return href
}

// ---------------------------------------------------------------------------
// Bing —— 上游 LocalBingProvider：'#b_results h2' 内取 a 的 textContent 与 href，
// href 为 https://www.bing.com/ck/a?...&u=a1<base64> 时去 'a1' 前缀 atob 解码。
// ---------------------------------------------------------------------------

function parseBing(html: string): ParsedSearchResult[] {
  const region = sliceRegion(html, /id="b_results"/i)
  const results: ParsedSearchResult[] = []

  for (const anchor of collectTaggedAnchors(region, 'h2')) {
    results.push(toResult(anchor, decodeBingHref(anchor.href)))
  }

  return dedupeByUrl(results)
}

/** Bing 重定向解码（上游 decodeBingUrl 同语义：u 参数去 'a1' 前缀 atob，解码失败回退原值）。 */
function decodeBingHref(bingUrl: string): string {
  try {
    const url = new URL(bingUrl)
    const encodedUrl = url.searchParams.get('u')
    if (!encodedUrl) {
      return bingUrl
    }
    const base64Part = encodedUrl.substring(2)
    const decodedUrl = atob(base64Part)
    if (decodedUrl.startsWith('http')) {
      return decodedUrl
    }
    return bingUrl
  } catch {
    return bingUrl
  }
}

// ---------------------------------------------------------------------------
// Baidu —— 上游 LocalBaiduProvider：'#content_left .result h3' 内取 a 的
// textContent 与 href（href 原样透传，多为 baidu.com/link 重定向）。
// ---------------------------------------------------------------------------

function parseBaidu(html: string): ParsedSearchResult[] {
  const region = sliceRegion(html, /<div[^>]*id="content_left"/i)
  const results: ParsedSearchResult[] = []

  for (const anchor of collectTaggedAnchors(region, 'h3')) {
    results.push(toResult(anchor, anchor.href))
  }

  return dedupeByUrl(results)
}
