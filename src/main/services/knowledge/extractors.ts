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
 * 零 CLI/Python 前置（2026-09-20 用户裁决）；pptx/xlsx/odt 用 officeparser
 * （纯文本，Markdown 级结构保真留债）；旧版二进制 .doc（OLE2）用
 * word-extractor（officeparser 明确不支持 .doc——真机实锤 2410570123实验报告.doc，
 * MarkItDown 同样不支持 .doc）；本地 .html 与网页 url 正文走 turndown 转
 * Markdown。sitemap/directory/video 后置。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { fetchWebContent } from '@main/services/webSearchProviders/webFetch'
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
  } else if (
    extension === '.pptx' ||
    extension === '.xlsx' ||
    extension === '.odt' ||
    extension === '.odp' ||
    extension === '.ods'
  ) {
    // 无可靠原生 Markdown 管线的 office 格式：officeparser 纯文本（留债）。
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
