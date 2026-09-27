import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildZip } from '../../preprocess/__tests__/zipTestHelper'
import { extractFromFile } from '../extractors'

// 切断 extractors → webFetch → SearchService 的传递图（同存量 extractors.test.ts）。
vi.mock('@main/services/webSearchProviders/webFetch', () => ({
  fetchWebContent: vi.fn(async () => ({ content: '' })),
  noContent: 'No content found'
}))

let dir = ''

beforeEach(async () => {
  // main.setup mock 掉了 os.tmpdir——用系统 TEMP 环境变量作临时根（存量同款）。
  dir = await mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'extractors-office-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('extractFromFile xlsx/pptx Markdown 级结构保真（v0.4 工程项）', () => {
  it('xlsx: emits per-sheet headings and GFM pipe tables', async () => {
    const XLSX = await import('@e965/xlsx')
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['产品', '数量'],
      ['苹果', '3'],
      ['香蕉', '12']
    ])
    XLSX.utils.book_append_sheet(wb, ws, '库存')
    const filePath = path.join(dir, 'sheet.xlsx')
    await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const { text } = await extractFromFile(filePath)
    expect(text).toContain('## 库存')
    expect(text).toContain('| 产品 | 数量 |')
    expect(text).toContain('| --- | --- |')
    expect(text).toContain('| 苹果 | 3 |')
  })

  it('pptx: slide text and a:tbl tables become Markdown sections', async () => {
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x">' +
      '<p:cSld><p:spTree>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>' +
      '<a:tr><a:tc><a:p><a:r><a:t>城市</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>销量</a:t></a:r></a:p></a:tc></a:tr>' +
      '<a:tr><a:tc><a:p><a:r><a:t>北京</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>42</a:t></a:r></a:p></a:tc></a:tr>' +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
      '</p:spTree></p:cSld></p:sld>'
    const zipBuffer = buildZip([{ name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml, 'utf-8') }])
    const filePath = path.join(dir, 'deck.pptx')
    await writeFile(filePath, zipBuffer)
    const { text } = await extractFromFile(filePath)
    expect(text).toContain('## Slide 1')
    expect(text).toContain('季度汇报')
    expect(text).toContain('| 城市 | 销量 |')
    expect(text).toContain('| 北京 | 42 |')
  })
})
