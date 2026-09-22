/**
 * 文档处理引擎行为测试（v0.3.2 路由表落地后的共用引擎面）：
 * - 纯文本直读 / 本地 html → turndown Markdown（真实文件、真实转换器）；
 * - docx 派发走 mammoth Markdown 管线、pptx 派发走 officeparser（mammoth/
 *   officeparser mock，验证派发方向与 turndown 实转换——mammoth 真实管线由
 *   scratch 合成 docx 实证）；
 * - PDF 文本层（合成 PDF + 真 pdf-parse）：全文原样返回，无扫描件检测
 *   （V2 对齐：检测是调用方/服务商的事，抽取层只管读）。
 * node:fs/promises 未被 main.setup mock（只 mock 了 node:fs）——真实临时文件可用。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildZip } from '../../preprocess/__tests__/zipTestHelper'

vi.mock('mammoth', () => ({
  // 真实 mammoth 的表格形态：全 <td> 无表头 + 块级 <p> 单元格（scratch 实证）——
  // 归一逻辑必须把它转成 GFM 管道表（normalizeMammothTables 的常驻回归）。
  convertToHtml: vi.fn(async ({ path: filePath }: { path: string }) => ({
    value:
      `<h1>Report ${filePath.split(/[\\/]/).pop()}</h1>` +
      '<table><tr><td><p>Head</p></td></tr><tr><td><p>A1</p></td><td><p>B1</p></td></tr></table>',
    messages: []
  }))
}))

vi.mock('officeparser', () => ({
  parseOfficeAsync: vi.fn(async () => 'pptx plain text')
}))

// 切断 extractors → webFetch → SearchService（静态 import { BrowserWindow } from
// 'electron'）的传递图——该边在 vitest 的 electron CJS interop 下收集期即炸
//（与 4 个存量 kernel 套件同一根因，见未清债）；本测试不触及 url 抽取。
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: vi.fn(async () => ({ content: '' }))
}))

import { extractFromFile } from '../extractors'

let dir = ''

// main.setup 未 mock node:fs/promises（真实临时文件可用）；os.tmpdir 被 mock 掉，
// 用系统 TEMP 环境变量作临时根。
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'extractors-test-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true })
    dir = ''
  }
})

async function writeTemp(name: string, content: Buffer | string): Promise<string> {
  const filePath = path.join(dir, name)
  await writeFile(filePath, content)
  return filePath
}

/** 构建最小合法 PDF（catalog/pages/font + 每页 page+content 对，手工 xref）。 */
function buildPdf(pageTexts: string[]): Buffer {
  const objs: string[] = []
  const pageObjNums = pageTexts.map((_, i) => 4 + i * 2)
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, i) => {
    const escaped = text.replace(/([()\\])/g, '\\$1')
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    objs[pageObjNums[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${pageObjNums[i] + 1} 0 R >>`
    objs[pageObjNums[i] + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let n = 1; n < objs.length; n++) pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

describe('extractFromFile: text and markdown routes', () => {
  it('reads plain text files directly', async () => {
    const filePath = await writeTemp('notes.md', '# Title\n\nbody text')
    const result = await extractFromFile(filePath)
    expect(result.text).toBe('# Title\n\nbody text')
    expect(result.source).toBe('notes.md')
  })

  it('converts local html files to Markdown via turndown', async () => {
    const filePath = await writeTemp('page.html', '<html><body><h1>Heading</h1><p>Paragraph text</p></body></html>')
    const result = await extractFromFile(filePath)
    expect(result.text).toContain('# Heading')
    expect(result.text).toContain('Paragraph text')
  })
})

describe('extractFromFile: office dispatch', () => {
  it('routes docx through the mammoth Markdown pipeline (officeparser untouched)', async () => {
    const mammoth = vi.mocked((await import('mammoth')).convertToHtml)
    const officeParser = vi.mocked((await import('officeparser')).parseOfficeAsync)
    const filePath = await writeTemp('report.docx', Buffer.from('not-a-real-zip'))
    const result = await extractFromFile(filePath)

    expect(mammoth).toHaveBeenCalledTimes(1)
    expect(officeParser).not.toHaveBeenCalled()
    expect(result.text).toContain('# Report report.docx')
    expect(result.text).toContain('| Head |')
    expect(result.text).toContain('| A1 | B1 |')
    expect(result.text).not.toMatch(/<table/i)
  })

  it('routes pptx through officeparser plain text', async () => {
    const mammoth = vi.mocked((await import('mammoth')).convertToHtml)
    const officeParser = vi.mocked((await import('officeparser')).parseOfficeAsync)
    const filePath = await writeTemp('slides.pptx', Buffer.from('not-a-real-zip'))
    const result = await extractFromFile(filePath)

    expect(officeParser).toHaveBeenCalledTimes(1)
    expect(mammoth).not.toHaveBeenCalled()
    expect(result.text).toBe('pptx plain text')
  })

  it.each(['.odp', '.ods'])('routes %s through officeparser (was falling to utf-8 garbage)', async (ext) => {
    const officeParser = vi.mocked((await import('officeparser')).parseOfficeAsync)
    const filePath = await writeTemp(`deck${ext}`, Buffer.from('not-a-real-zip'))
    const result = await extractFromFile(filePath)

    expect(officeParser).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('pptx plain text')
  })
})

describe('extractFromFile: pdf text layer (real pdf-parse, synthetic pdfs; V2 对齐：无扫描件检测)', () => {
  it('returns the full text layer as-is', async () => {
    const filePath = await writeTemp(
      'text-layer.pdf',
      buildPdf(['Meaningful body text for the text layer, well above thirty characters.'])
    )
    const result = await extractFromFile(filePath)
    expect(result.text).toContain('Meaningful body text')
  })

  it('returns artifact-only text as-is (detection is the caller/provider concern, not the extractor)', async () => {
    const filePath = await writeTemp('scanned.pdf', buildPdf(['1', '2']))
    const result = await extractFromFile(filePath)
    // pdf-parse 对多页文档追加 "-- N of M --" 分隔行——断言只看页码伪迹本身在场。
    expect(result.text).toContain('1')
    expect(result.text).toContain('2')
    expect(result.text).toContain('-- 1 of 2 --')
  })
})

describe('extractFromFile: epub (real zip, container → OPF → spine xhtml → Markdown)', () => {
  it('extracts spine chapters in order as Markdown', async () => {
    const container =
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    const opf =
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
      '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="css" href="style.css" media-type="text/css"/></manifest>' +
      '<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="css"/></spine></package>'
    const ch1 = '<html><body><h1>Chapter One</h1><p>First paragraph.</p></body></html>'
    const ch2 = '<html><body><h2>Chapter Two</h2><p>Second paragraph.</p></body></html>'
    const zipBytes = buildZip([
      { name: 'mimetype', data: Buffer.from('application/epub+zip') },
      { name: 'META-INF/container.xml', data: Buffer.from(container) },
      { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
      { name: 'OEBPS/ch1.xhtml', data: Buffer.from(ch1) },
      { name: 'OEBPS/text/ch2.xhtml', data: Buffer.from(ch2) },
      { name: 'OEBPS/style.css', data: Buffer.from('body{}') }
    ])
    const filePath = await writeTemp('book.epub', zipBytes)

    const result = await extractFromFile(filePath)

    expect(result.text).toContain('# Chapter One')
    expect(result.text).toContain('First paragraph.')
    expect(result.text.indexOf('Chapter One')).toBeLessThan(result.text.indexOf('Chapter Two'))
    expect(result.text).toContain('## Chapter Two')
    expect(result.text).toContain('Second paragraph.')
    expect(result.text).not.toContain('body{}')
  })

  it('skips a missing chapter file but fails when the spine yields nothing readable', async () => {
    const container =
      '<?xml version="1.0"?><container version="1.0">' +
      '<rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    const opf =
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
      '<manifest><item id="a" href="gone.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="b" href="also-gone.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="a"/><itemref idref="b"/></spine></package>'
    const zipBytes = buildZip([
      { name: 'META-INF/container.xml', data: Buffer.from(container) },
      { name: 'book.opf', data: Buffer.from(opf) }
    ])
    const filePath = await writeTemp('broken.epub', zipBytes)

    await expect(extractFromFile(filePath)).rejects.toThrow(/no readable chapters/)
  })
})
