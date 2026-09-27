/**
 * 文档处理系统抽取器（批次4 建立为知识库摄取；v0.3.2 验收轮起为共用引擎）：
 * 知识库条目摄取（KnowledgeService.processItem）与聊天读文件
 *（KnowledgeService.readTurnDocument ← read_document 工具）双入口共用本层——
 * file（pdf/doc/docx/txt/md/html 族）+ url（网页正文）+ note（直取）。
 *
 * fork 裁剪：不移植 embedjs loader 全家（embedjs-loader-web/sitemap 等）；
 * PDF 用 dependencies 已有 pdf-parse@2 读文本层（V2 对齐：本层无扫描件检测，
 * 空文本由调用方如实报错；配置了服务商的库在 KnowledgeService 层整本路由）；
 * docx 走 mammoth（docx→HTML）
 * + turndown(-gfm)（HTML→Markdown）——MarkItDown 同款管线原生进程内实现，
 * 零 CLI/Python 前置（2026-09-20 用户裁决）；xlsx 用 SheetJS（@e965/xlsx，V1 同款
 * fork）逐工作表 GFM 管道表、pptx 用 zip+OOXML 直解析（幻灯片/表格/备注，v0.4
 * 工程项：V1 亦为 officeparser 纯文本，无上游先例，按 MarkItDown 表格语义自建）；
 * odt/odp/ods 用 officeparser（纯文本）；旧版二进制 .doc（OLE2）用
 * word-extractor（officeparser 明确不支持 .doc——真机实锤 2410570123实验报告.doc，
 * MarkItDown 同样不支持 .doc）；本地 .html 与网页 url 正文走 turndown 转
 * Markdown。sitemap/directory/video 已接入（v0.4 工程项）。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { fetchWebContent, noContent } from '@main/services/webSearchProviders/webFetch'
import { textExts } from '@shared/config/constant'
import StreamZip from 'node-stream-zip'
import type TurndownService from 'turndown'
import type WordExtractor from 'word-extractor'

const logger = loggerService.withContext('KnowledgeExtractors')

export interface ExtractedContent {
  /** 抽取出的纯文本（调用方分块）。 */
  text: string
  /** 来源标识（随 chunk metadata 落库，检索结果回显用）。 */
  source: string
}

/** 纯文本扩展名（直读 utf-8）。 */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yaml', '.yml'])

async function extractPdf(buffer: Buffer, source: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText()
    logger.info(`knowledge: pdf "${source}" text layer: ${result.text?.length ?? 0} chars`)
    return result.text ?? ''
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

let markdownConverter: TurndownService | undefined

/** HTML → Markdown（turndown + GFM 表格插件；进程内纯 JS，Node 侧经 domino
 * 解析——无 jsdom 前置，真机 node 实证 7.2.0 可用）。实例缓存复用。 */
async function htmlToMarkdown(html: string): Promise<string> {
  if (markdownConverter === undefined) {
    const { default: TurndownServiceImpl } = await import('turndown')
    const { gfm } = await import('turndown-plugin-gfm')
    markdownConverter = new TurndownServiceImpl({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    markdownConverter.use(gfm)
  }
  return markdownConverter.turndown(html)
}

/** mammoth 表格归一（scratch 真实 docx 实证的两个坑）：
 * 1) 单元格是块级 `<td><p>..</p></td>`——GFM 插件拒块级子节点，多段以 <br> 内联；
 * 2) 全部行是 `<td>` 无表头——GFM 插件要求 thead/th 表头行，首行升 th 包 thead、
 *    其余行进 tbody（与 MarkItDown 对 docx 表格的表头语义一致）。 */
function normalizeMammothTables(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/gi, (_match, inner: string) => {
    const [headRow, ...bodyRows] = inner.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []
    if (headRow === undefined) return _match
    const inlineRow = (row: string): string =>
      row.replace(/<t([hd])>([\s\S]*?)<\/t\1>/gi, (_cell, tag: string, content: string) => {
        const inlined = content.replace(/<\/p>\s*<p>/gi, '<br>').replace(/<\/?p>/gi, '')
        return `<t${tag}>${inlined}</t${tag}>`
      })
    const head = inlineRow(headRow)
      .replace(/<td>/gi, '<th>')
      .replace(/<\/td>/gi, '</th>')
    const body = bodyRows.map(inlineRow).join('')
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
  })
}

/** docx → Markdown：mammoth（docx→HTML，标题/列表/表格映射）+ turndown
 * （HTML→Markdown）——MarkItDown 的 docx 管线同款，原生进程内执行。 */
async function extractDocxToMarkdown(filePath: string): Promise<string> {
  const mammoth = await import('mammoth')
  // CJS 互操作：named 探测由 cjs-module-lexer 决定，named/default 两形态并存兼容。
  const convert = mammoth.convertToHtml ?? mammoth.default.convertToHtml
  if (convert === undefined) throw new Error('knowledge: mammoth API unavailable')
  const { value: html } = await convert({ path: filePath })
  return htmlToMarkdown(normalizeMammothTables(html))
}

async function extractOfficeText(filePath: string): Promise<string> {
  const officeParser = await import('officeparser')
  // officeparser 导出形态兼容：CJS default / ESM named parseOfficeAsync。
  const parse = ((officeParser as unknown as Record<string, unknown>).parseOfficeAsync ??
    (officeParser as unknown as { default?: Record<string, unknown> }).default?.parseOfficeAsync) as
    | ((filePath: string) => Promise<string>)
    | undefined
  if (parse === undefined) throw new Error('knowledge: officeparser API unavailable')
  return parse(filePath)
}

// ---- xlsx / pptx 的 Markdown 级结构保真（v0.4 工程项：V1 也是纯文本 officeparser，
// 无上游先例——按 MarkItDown 的表格语义自建：工作表/幻灯片标题 + GFM 管道表）。----

/** 二维值表 → GFM 管道表（首行升表头；空表跳过由调用方处理）。宽度用循环求——
 *  展开运算符在大表（数万行）上栈溢出（真机 2026-09-27 xlsx 失败的根因候选）。 */
function rowsToGfmTable(rows: string[][]): string {
  const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  let width = 1
  for (const row of rows) {
    if (row.length > width) width = row.length
  }
  const padded = rows.map((row) => Array.from({ length: width }, (_, i) => cell(row[i] ?? '')))
  const [head, ...body] = padded
  const lines = [
    `| ${head?.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ]
  return lines.join('\n')
}

/**
 * xlsx → Markdown：SheetJS（@e965/xlsx，V1 同款 fork）逐工作表 `## 表名` + GFM
 * 管道表（首行表头）。**结构化抽取失败回退 officeparser 纯文本**（v0.3.2 时代的
 * 可用路径；真实世界 xlsx 变体远多于合成样本，保底不比报废强）——失败落 warn。
 */
async function extractXlsxToMarkdown(filePath: string): Promise<string> {
  try {
    const XLSX = await import('@e965/xlsx')
    const workbook = XLSX.read(await readFile(filePath), { type: 'buffer' })
    const sections: string[] = []
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name]
      if (sheet === undefined) continue
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' })
      const meaningful = rows.filter((row) => row.some((value) => String(value).trim().length > 0))
      if (meaningful.length === 0) continue
      sections.push(`## ${name}\n\n${rowsToGfmTable(meaningful as string[][])}`)
    }
    if (sections.length === 0) {
      throw new Error(`knowledge: xlsx "${path.basename(filePath)}" has no non-empty sheets`)
    }
    return sections.join('\n\n')
  } catch (error) {
    logger.warn(`knowledge: xlsx structured extraction failed, falling back to officeparser:`, error as Error)
    return await extractOfficeText(filePath)
  }
}

/** OOXML 文本段归一：去掉 XML 转义残留、按段落边界保留换行。 */
function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** pptx（zip 内 OOXML）→ Markdown：node-stream-zip 直读（进程内零 CLI）。
 *  幻灯片按数字序：`## Slide N` + 形状段落文本（a:p）+ 表格（a:tbl → GFM）；
 *  对应备注页文本附在幻灯片末（officeparser 语义：备注文本属文档）。
 *  结构化失败同样回退 officeparser（与 xlsx 同理由）。 */
async function extractPptxToMarkdown(filePath: string): Promise<string> {
  try {
    return await extractPptxStructured(filePath)
  } catch (error) {
    logger.warn('knowledge: pptx structured extraction failed, falling back to officeparser:', error as Error)
    return await extractOfficeText(filePath)
  }
}

async function extractPptxStructured(filePath: string): Promise<string> {
  const zip = new StreamZip.async({ file: filePath })
  try {
    const entries = await zip.entries()
    const readEntry = async (name: string): Promise<string> => (await zip.entryData(name)).toString('utf-8')
    const slideNames = Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const num = (n: string): number => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0)
        return num(a) - num(b)
      })
    if (slideNames.length === 0) {
      throw new Error(`knowledge: pptx "${path.basename(filePath)}" contains no slides`)
    }
    const sections: string[] = []
    for (let index = 0; index < slideNames.length; index++) {
      const slideName = slideNames[index] ?? ''
      const xml = await readEntry(slideName)
      const parts: string[] = []
      // 表格（a:tbl）→ GFM：行 a:tr / 单元格 a:tc，取单元格全部 a:t 文本。
      const tablePattern = /<a:tbl>[\s\S]*?<\/a:tbl>/g
      let textWithoutTables = xml
      for (const table of xml.match(tablePattern) ?? []) {
        textWithoutTables = textWithoutTables.replace(table, '')
        const rows: string[][] = []
        for (const tr of table.match(/<a:tr[\s\S]*?<\/a:tr>/g) ?? []) {
          const cells = (tr.match(/<a:tc[\s\S]*?<\/a:tc>/g) ?? []).map((tc) =>
            [...tc.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
              .map((m) => decodeXmlText(m[1] ?? ''))
              .join('')
              .trim()
          )
          rows.push(cells)
        }
        if (rows.length > 0) parts.push(rowsToGfmTable(rows))
      }
      // 形状段落文本：按 a:p 分段，段内 a:t 串联。
      for (const paragraph of textWithoutTables.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
        const text = [...paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => decodeXmlText(m[1] ?? ''))
          .join('')
          .trim()
        if (text.length > 0) parts.push(text)
      }
      if (parts.length === 0) continue
      const notesName = `ppt/notesSlides/notesSlide${index + 1}.xml`
      if (entries[notesName] !== undefined) {
        const notesXml = await readEntry(notesName)
        const notes = [...notesXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => decodeXmlText(m[1] ?? ''))
          .join('')
          .trim()
        if (notes.length > 0) parts.push(`> ${notes.replace(/\s+/g, ' ')}`)
      }
      sections.push(`## Slide ${index + 1}\n\n${parts.join('\n\n')}`)
    }
    if (sections.length === 0) {
      throw new Error(`knowledge: pptx "${path.basename(filePath)}" has no text content in slides`)
    }
    return sections.join('\n\n')
  } finally {
    await zip.close().catch(() => undefined)
  }
}

/** zip 内相对路径归一（处理 ./ 与 ../；zip 条目名不含盘符与反斜杠）。 */
function resolveZipPath(dir: string, target: string): string {
  const parts: string[] = []
  for (const seg of (dir + target).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** epub → Markdown（MarkItDown 同思路，进程内零新依赖）：容器是 zip——
 * container.xml 定 OPF，OPF manifest+spine 定阅读顺序，xhtml/html 章节走
 * htmlToMarkdown；缺章跳过（坏 epub 常见），全缺才报错。 */
async function extractEpubToMarkdown(filePath: string): Promise<string> {
  const zip = new StreamZip.async({ file: filePath })
  try {
    const entries = await zip.entries()
    const readEntry = async (name: string): Promise<string> => {
      const entry = entries[name]
      if (entry === undefined) throw new Error(`epub: missing entry "${name}"`)
      return (await zip.entryData(name)).toString('utf-8')
    }
    const container = await readEntry('META-INF/container.xml')
    const opfPath = container.match(/full-path="([^"]+)"/)?.[1]
    if (opfPath === undefined) throw new Error('epub: container.xml declares no rootfile')
    const opf = await readEntry(opfPath)
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
    const hrefById = new Map<string, string>()
    for (const tag of opf.match(/<item\b[^>]*>/g) ?? []) {
      const id = tag.match(/\bid="([^"]*)"/)?.[1]
      const href = tag.match(/\bhref="([^"]*)"/)?.[1]
      if (id !== undefined && href !== undefined) hrefById.set(id, href)
    }
    const chapters: string[] = []
    for (const ref of opf.match(/<itemref\b[^>]*>/g) ?? []) {
      const idref = ref.match(/\bidref="([^"]*)"/)?.[1]
      const href = idref !== undefined ? hrefById.get(idref) : undefined
      if (href === undefined) continue
      const target = decodeURIComponent(href.split('#')[0])
      if (!/\.(x?html|htm)$/i.test(target)) continue
      const name = resolveZipPath(opfDir, target)
      if (entries[name] === undefined) continue
      chapters.push(await htmlToMarkdown(await readEntry(name)))
    }
    if (chapters.length === 0) {
      throw new Error(`epub "${path.basename(filePath)}": no readable chapters in spine`)
    }
    return chapters.join('\n\n')
  } finally {
    await zip.close().catch(() => undefined)
  }
}

/** 旧版二进制 .doc（OLE2/CFB）：officeparser 明确不支持，走 word-extractor（纯 JS，
 * 依赖已在 dependencies：上游遗留 + @types/word-extractor）。取正文 body；页眉脚注
 * 等外围不进知识库（与 docx 路线的正文语义对齐）。 */
async function extractLegacyDoc(filePath: string): Promise<string> {
  // CJS export= 形态：Node ESM 互操作下类挂在 default；运行时形状按 officeparser
  // 同款兼容写法取（@types/word-extractor 提供类型侧）。
  const mod = (await import('word-extractor')) as unknown as { default: new () => WordExtractor }
  const document = await new mod.default().extract(filePath)
  return document.getBody()
}

/** 按文件扩展名/类型抽取文本。 */
export async function extractFromFile(filePath: string): Promise<ExtractedContent> {
  const extension = path.extname(filePath).toLowerCase()
  const source = path.basename(filePath)
  let text = ''
  if (extension === '.pdf') {
    text = await extractPdf(await readFile(filePath), source)
  } else if (extension === '.doc') {
    // 旧版二进制 .doc：officeparser/MarkItDown 均明确不支持（真机实锤报错），走 word-extractor。
    text = await extractLegacyDoc(filePath)
  } else if (extension === '.docx') {
    // docx：Markdown 级抽取（mammoth + turndown，标题/列表/表格保真）。
    text = await extractDocxToMarkdown(filePath)
  } else if (extension === '.pptx') {
    // pptx：Markdown 级抽取（zip+OOXML 直解析：幻灯片段落 + 表格 GFM + 备注）。
    text = await extractPptxToMarkdown(filePath)
  } else if (extension === '.xlsx') {
    // xlsx：Markdown 级抽取（SheetJS 逐工作表 GFM 管道表）。
    text = await extractXlsxToMarkdown(filePath)
  } else if (extension === '.odt' || extension === '.odp' || extension === '.ods') {
    // 无原生管线价值的 OpenDocument 族：officeparser 纯文本。
    text = await extractOfficeText(filePath)
  } else if (extension === '.epub') {
    text = await extractEpubToMarkdown(filePath)
  } else if (extension === '.html' || extension === '.htm') {
    text = await htmlToMarkdown(await readFile(filePath, 'utf-8'))
  } else if (TEXT_EXTENSIONS.has(extension)) {
    text = await readFile(filePath, 'utf-8')
  } else {
    // 未知扩展名按文本尝试（长度为 0 时由调用方报错，不静默成功）。
    text = await readFile(filePath, 'utf-8').catch(() => '')
  }
  logger.info(`knowledge: extracted ${text.length} chars from file "${source}"`)
  return { text, source }
}

/** 从二进制 buffer 抽取（FileMetadata 的 raw path 不可达时用；MVP 传入 path 即可）。 */
export async function extractFromBuffer(buffer: Buffer, filename: string): Promise<ExtractedContent> {
  const extension = path.extname(filename).toLowerCase()
  const text = extension === '.pdf' ? await extractPdf(buffer, filename) : buffer.toString('utf-8')
  return { text, source: filename }
}

/** 网页正文（复用批次2 管线：直 fetch 失败回退隐藏窗口刮取，纯文本输出）。 */
export async function extractFromUrl(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
  const result = await fetchWebContent(url, 'text', false, { signal })
  const text = result.content ?? ''
  if (text.length === 0) {
    throw new Error(`knowledge: no content extracted from url ${url}`)
  }
  return { text, source: url }
}

/** 笔记/直接文本。 */
export function extractFromNote(content: string, source: string): ExtractedContent {
  return { text: content, source }
}

// ===========================================================================
// sitemap / directory / video（v0.4 工程项：三类条目接入处理链）
// ===========================================================================

/** 目录摄取接受的扩展名：@shared 的 textExts（V1 同源——code-languages 派生的
 * 语言学代码扩展全集 + 自定义文本扩展）+ 文档/电子书/网页族（v0.4 真机验收轮修正：
 * 此前只收 13 种扩展，V1 接受的 .ts/.py/.go 等源码文件被静默漏掉）。 */
const DIRECTORY_FILE_EXTENSIONS = new Set<string>([
  ...textExts,
  ...TEXT_EXTENSIONS,
  '.pdf',
  '.doc',
  '.docx',
  '.pptx',
  '.xlsx',
  '.odt',
  '.odp',
  '.ods',
  '.epub',
  '.html',
  '.htm'
])

/** 目录扫描跳过的目录名（V1 只跳点开头项；node_modules/.git 一扫就是数万文件，
 * fork 补上——V1 的这一缺口不照抄）。 */
const DIRECTORY_IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'coverage'])

/** 递归枚举目录下的可摄取文件（跳点项与常见生成物目录）。 */
export async function listDirectoryFiles(dirPath: string): Promise<string[]> {
  const results: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || DIRECTORY_IGNORED_DIRS.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && DIRECTORY_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full)
      }
    }
  }
  await walk(dirPath)
  results.sort()
  return results
}

/** sitemap 单页抓取上限（V1 无上限——巨型 sitemapindex 会无节制打满网络，fork 补上）。 */
const SITEMAP_MAX_PAGES = 200
/** sitemap 页面抓取并发。 */
const SITEMAP_FETCH_CONCURRENCY = 5

/**
 * sitemap → 页面正文列表（V1 SitemapLoader 语义：sitemapper 解析 urlset/sitemapindex，
 * 索引递归由 sitemapper 内部处理；每页 WebLoader 抓正文）。单页失败跳过不整链失败
 * （V1 同语义），全部为空时调用方报错。
 */
export async function extractFromSitemap(sitemapUrl: string, signal?: AbortSignal): Promise<ExtractedContent[]> {
  const { default: Sitemapper } = await import('sitemapper')
  const mapper = new Sitemapper({ url: sitemapUrl, timeout: 15000 })
  const { sites } = await mapper.fetch()
  const urls = (sites ?? []).slice(0, SITEMAP_MAX_PAGES)
  if (sites !== undefined && sites.length > SITEMAP_MAX_PAGES) {
    logger.warn(
      `knowledge: sitemap "${sitemapUrl}" lists ${sites.length} urls, capped at ${SITEMAP_MAX_PAGES} (fork limit)`
    )
  }
  logger.info(`knowledge: sitemap "${sitemapUrl}" -> ${urls.length} url(s)`)
  if (urls.length === 0) {
    throw new Error(`knowledge: sitemap ${sitemapUrl} yielded no urls`)
  }

  const results: ExtractedContent[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < urls.length) {
      const index = cursor++
      const url = urls[index]
      if (url === undefined) continue
      try {
        const page = await fetchWebContent(url, 'markdown', false, { signal })
        const text = page.content ?? ''
        if (text.trim().length === 0 || text === noContent) continue
        results.push({ text, source: url })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        logger.warn(`knowledge: sitemap page "${url}" failed, skipping:`, error as Error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SITEMAP_FETCH_CONCURRENCY, urls.length) }, () => worker()))
  return results
}

/** SRT 时间戳 → 秒（"00:01:02,500" / "00:01:02.500"）。 */
function srtTimestampToSeconds(raw: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(raw.trim())
  if (match === null) return NaN
  const [, h, m, s, ms] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
}

/** 字幕窗口目标长度（字符）与最大跨度（秒）——按窗口切块，检索命中可回溯时间区间。 */
const SRT_WINDOW_CHARS = 1200
const SRT_WINDOW_SPAN_SECONDS = 90

/**
 * 视频条目（V1 契约：本地视频 + .srt 字幕对）→ 字幕窗口文本列表。
 * V1.9.11 的 video 类型实为无后端的 UI 脚手架（勘查实证），本实现按其预留契约
 * 新写：SRT 解析 → 按 ~1200 字符 / 90s 跨度聚窗 → source = 视频文件名，窗口文本
 * 自带 "[mm:ss]" 起点标记，检索命中可人工定位时间点。
 */
export async function extractFromVideoPair(videoPath: string, srtPath: string): Promise<ExtractedContent[]> {
  const raw = await readFile(srtPath, 'utf-8')
  const source = path.basename(videoPath)
  // 容忍 BOM 与 \r\n。
  const blocks = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
  type Cue = { start: number; text: string }
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    const timeLine = lines.find((line) => line.includes('-->'))
    if (timeLine === undefined) continue
    const start = srtTimestampToSeconds(timeLine.split('-->')[0] ?? '')
    const text = lines
      .filter((line) => line !== timeLine && !/^\d+$/.test(line.trim()))
      .join(' ')
      .trim()
    if (text.length === 0 || !Number.isFinite(start)) continue
    cues.push({ start, text })
  }
  if (cues.length === 0) {
    throw new Error(`knowledge: srt "${path.basename(srtPath)}" contains no cues`)
  }

  const formatTimestamp = (seconds: number): string => {
    const total = Math.floor(seconds)
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const windows: ExtractedContent[] = []
  let buffer = ''
  let windowStart = cues[0]?.start ?? 0
  for (const cue of cues) {
    if (
      buffer.length > 0 &&
      (buffer.length + cue.text.length > SRT_WINDOW_CHARS || cue.start - windowStart > SRT_WINDOW_SPAN_SECONDS)
    ) {
      windows.push({ text: `[${formatTimestamp(windowStart)}] ${buffer}`, source })
      buffer = ''
      windowStart = cue.start
    }
    if (buffer.length === 0) windowStart = cue.start
    buffer = buffer.length === 0 ? cue.text : `${buffer} ${cue.text}`
  }
  if (buffer.length > 0) {
    windows.push({ text: `[${formatTimestamp(windowStart)}] ${buffer}`, source })
  }
  return windows
}
