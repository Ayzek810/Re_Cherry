import { parsePdfWithProvider, preprocessChannel } from '@main/services/preprocess/preprocessChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { extractFromFile } from '../extractors'
import { KnowledgeService } from '../KnowledgeService'

// 三条外部缝全 mock：extractors（文本抽取）、preprocessChannel（文档处理通道路由，
// §7.17 三轮：工具按通道服务商路由，不再直连 LocalPaddle）。ProviderKeyStore 一并
// mock 以切断 electron-store 的模块级落盘（embeddings.ts 的导入链）。
vi.mock('../extractors', () => ({
  extractFromFile: vi.fn(),
  extractFromBuffer: vi.fn(),
  extractFromUrl: vi.fn(),
  extractFromNote: vi.fn()
}))
vi.mock('@main/services/preprocess/preprocessChannel', () => ({
  parsePdfWithProvider: vi.fn(),
  preprocessChannel: {
    setConfig: vi.fn(),
    getConfig: vi.fn(),
    setTurnProvider: vi.fn(),
    getTurnProviderId: vi.fn()
  }
}))
vi.mock('@main/services/ProviderKeyStore', () => ({
  providerKeyStore: { get: vi.fn(() => undefined) }
}))
// addItem 全链路只验证到"按服务商路由的 OCR 回退"为止：嵌入与向量库桩掉
//（嵌入路由解析依赖真实 apiHost 快照，向量库要开 SQLite——均与本组断言无关）。
vi.mock('../embeddings', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    setProviders: vi.fn(),
    embed: vi.fn(async (_ref: unknown, inputs: string[]) => inputs.map(() => [0.1, 0.2, 0.3, 0.4]))
  }))
}))
vi.mock('../vectorStore', () => ({
  BaseVectorStore: {
    open: vi.fn(async () => ({ insert: vi.fn(async () => {}) }))
  }
}))

/** 单例每轮登记为空起步（setTurnDocuments(undefined) 清空）。 */
function service(): KnowledgeService {
  return KnowledgeService.getInstance()
}

describe('readTurnDocument（2026-09-22 用户第二轮裁决：直读为中心，无截断）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const svc = service()
    svc.setTurnDocuments('topic-read', undefined)
    svc.setTurnDocuments('topic-scan', undefined)
    svc.setTurnDocuments('topic-empty', undefined)
    svc.setTurnDocuments('topic-unknown', undefined)
  })

  it('PDF 也走 extractFromFile 直读（文本层），不碰文档处理通道', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-read', [{ name: 'book.pdf', path: 'C:/books/book.pdf' }])
    vi.mocked(extractFromFile).mockResolvedValue({ text: '文本层正文', source: 'book.pdf' })

    const result = await svc.readTurnDocument('topic-read', 'book.pdf')

    expect(extractFromFile).toHaveBeenCalledWith('C:/books/book.pdf')
    expect(parsePdfWithProvider).not.toHaveBeenCalled()
    expect(result).toEqual({ name: 'book.pdf', text: '文本层正文' })
  })

  it('已读不截断：250,000 字符全文原样返回（200k 上限已按用户裁决删除）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-read', [{ name: 'big.txt', path: 'C:/books/big.txt' }])
    vi.mocked(extractFromFile).mockResolvedValue({ text: '字'.repeat(250_000), source: 'big.txt' })

    const result = await svc.readTurnDocument('topic-read', 'big.txt')

    expect(result.text).toBe('字'.repeat(250_000))
    expect(result.name).toBe('big.txt')
  })

  it('扫描件伪迹：原样返回（直读无扫描件检测，模型自行决定是否走 ocr_document）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-scan', [{ name: 'scan.pdf', path: 'C:/books/scan.pdf' }])
    vi.mocked(extractFromFile).mockResolvedValue({ text: '1 2 3', source: 'scan.pdf' })

    const result = await svc.readTurnDocument('topic-scan', 'scan.pdf')
    expect(result.text).toBe('1 2 3')
  })

  it('空抽取：不报错，返回中性提示作为工具结果（V2 noExtractableTextNote 同形状）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-empty', [{ name: 'empty.txt', path: 'C:/books/empty.txt' }])
    vi.mocked(extractFromFile).mockResolvedValue({ text: '   ', source: 'empty.txt' })

    const result = await svc.readTurnDocument('topic-empty', 'empty.txt')
    expect(result.name).toBe('empty.txt')
    expect(result.text).toBe('(No extractable text — the document may be empty, scanned, or in an unreadable format.)')
  })

  it('文档未登记：如实报错', async () => {
    await expect(service().readTurnDocument('topic-unknown', 'nope.txt')).rejects.toThrow(
      'not attached to this conversation turn'
    )
  })
})

describe('ocrTurnDocument（§7.17 三轮：挂进文档处理通道，按通道服务商路由）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const svc = service()
    svc.setTurnDocuments('topic-ocr', undefined)
    svc.setTurnDocuments('topic-ocr-cloud', undefined)
    svc.setTurnDocuments('topic-ocr-unconfigured', undefined)
    svc.setTurnDocuments('topic-ocr-doc', undefined)
    svc.setTurnDocuments('topic-ocr-unknown', undefined)
  })

  it('未登记服务商：如实报错不静默降级（2026-09-22 用户裁决：删除 local-paddle 缺省兜底）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-ocr', [{ name: 'scan.pdf', path: 'C:/books/scan.pdf' }])
    vi.mocked(preprocessChannel.getTurnProviderId).mockReturnValue(undefined)

    await expect(svc.ocrTurnDocument('topic-ocr', 'scan.pdf')).rejects.toThrow(
      /no document-processing provider is registered/
    )
    expect(parsePdfWithProvider).not.toHaveBeenCalled()
  })

  it('本轮登记了云端服务商：按登记路由（配置从通道配置表反查）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-ocr-cloud', [{ name: 'scan.pdf', path: 'C:/books/scan.pdf' }])
    vi.mocked(preprocessChannel.getTurnProviderId).mockReturnValue('mineru')
    vi.mocked(preprocessChannel.getConfig).mockImplementation((id) =>
      id === 'mineru' ? { id: 'mineru', apiKey: 'k', apiHost: 'https://mineru.net' } : undefined
    )
    vi.mocked(parsePdfWithProvider).mockResolvedValue('云解析全文')

    const result = await svc.ocrTurnDocument('topic-ocr-cloud', 'scan.pdf')

    expect(preprocessChannel.getConfig).toHaveBeenCalledWith('mineru')
    expect(parsePdfWithProvider).toHaveBeenCalledWith(
      { id: 'mineru', apiKey: 'k', apiHost: 'https://mineru.net' },
      'C:/books/scan.pdf'
    )
    expect(result).toEqual({ name: 'scan.pdf', text: '云解析全文' })
  })

  it('登记的服务商未配置：如实报可行动错误（指引设置页），不静默降级', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-ocr-unconfigured', [{ name: 'scan.pdf', path: 'C:/books/scan.pdf' }])
    vi.mocked(preprocessChannel.getTurnProviderId).mockReturnValue('doc2x')
    vi.mocked(preprocessChannel.getConfig).mockReturnValue(undefined)

    await expect(svc.ocrTurnDocument('topic-ocr-unconfigured', 'scan.pdf')).rejects.toThrow(/doc2x.*is not configured/)
    expect(parsePdfWithProvider).not.toHaveBeenCalled()
  })

  it('非 PDF：如实报错（通道只接 PDF）', async () => {
    const svc = service()
    svc.setTurnDocuments('topic-ocr-doc', [{ name: 'notes.docx', path: 'C:/books/notes.docx' }])

    await expect(svc.ocrTurnDocument('topic-ocr-doc', 'notes.docx')).rejects.toThrow('only supports PDF')
    expect(parsePdfWithProvider).not.toHaveBeenCalled()
  })

  it('文档未登记：如实报错', async () => {
    await expect(service().ocrTurnDocument('topic-ocr-unknown', 'nope.pdf')).rejects.toThrow(
      'not attached to this conversation turn'
    )
  })
})

describe('processItem PDF 路由（V2 对齐：配置即路由，2026-09-22 用户裁决）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('库配置了服务商：所有 PDF 整本走该服务商（文本层 PDF 也走，无预算）', async () => {
    const svc = service()
    vi.mocked(parsePdfWithProvider).mockResolvedValue('服务商解析全文')
    vi.mocked(preprocessChannel.getConfig).mockImplementation((id) =>
      id === 'mineru' ? { id: 'mineru', apiKey: 'k' } : undefined
    )

    await svc.addItem(
      { kind: 'file', baseId: 'base-1', itemId: 'item-1', filePath: 'C:/books/text-layer.pdf' },
      { id: 'base-1', preprocessProviderId: 'mineru' },
      { providerId: 'p', modelId: 'm' }
    )

    expect(extractFromFile).not.toHaveBeenCalled()
    expect(parsePdfWithProvider).toHaveBeenCalledWith(
      { id: 'mineru', apiKey: 'k' },
      'C:/books/text-layer.pdf',
      undefined,
      {
        budgetMs: Number.POSITIVE_INFINITY
      }
    )
  })

  it('库未配置服务商：纯文本层直取，零检测零路由', async () => {
    const svc = service()
    vi.mocked(extractFromFile).mockResolvedValue({ text: '文本层正文', source: 'book.pdf' })

    await svc.addItem(
      { kind: 'file', baseId: 'base-2', itemId: 'item-2', filePath: 'C:/books/book.pdf' },
      { id: 'base-2' },
      { providerId: 'p', modelId: 'm' }
    )

    expect(parsePdfWithProvider).not.toHaveBeenCalled()
    expect(extractFromFile).toHaveBeenCalledWith('C:/books/book.pdf')
  })

  it('配置了服务商但配置表查无此项：如实报错，不静默回退文本层', async () => {
    const svc = service()
    vi.mocked(preprocessChannel.getConfig).mockReturnValue(undefined)

    await expect(
      svc.addItem(
        { kind: 'file', baseId: 'base-3', itemId: 'item-3', filePath: 'C:/books/scan.pdf' },
        { id: 'base-3', preprocessProviderId: 'doc2x' },
        { providerId: 'p', modelId: 'm' }
      )
    ).rejects.toThrow(/doc2x.*is not configured/)
    expect(parsePdfWithProvider).not.toHaveBeenCalled()
    expect(extractFromFile).not.toHaveBeenCalled()
  })

  it('非 PDF 文件不路由：配置了服务商也走文本抽取', async () => {
    const svc = service()
    vi.mocked(extractFromFile).mockResolvedValue({ text: 'docx 正文', source: 'notes.docx' })
    vi.mocked(preprocessChannel.getConfig).mockReturnValue({ id: 'mineru', apiKey: 'k' })

    await svc.addItem(
      { kind: 'file', baseId: 'base-4', itemId: 'item-4', filePath: 'C:/books/notes.docx' },
      { id: 'base-4', preprocessProviderId: 'mineru' },
      { providerId: 'p', modelId: 'm' }
    )

    expect(parsePdfWithProvider).not.toHaveBeenCalled()
    expect(extractFromFile).toHaveBeenCalledWith('C:/books/notes.docx')
  })
})
