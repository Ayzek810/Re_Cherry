import { beforeEach, describe, expect, it, vi } from 'vitest'

// 单个可换实现的 parse/turndown mock：空正文用例需要让解析链返回空内容
// （`vi.mocked(Readability).mockImplementationOnce` 对类 mock 的构造返回值不生效）。
const parseMock = vi.hoisted(() => vi.fn())
const turndownMock = vi.hoisted(() => vi.fn())

// Mock 外部依赖
vi.mock('turndown', () => ({
  default: vi.fn(() => ({
    turndown: turndownMock
  }))
}))
vi.mock('@mozilla/readability', () => ({
  Readability: vi.fn(() => ({
    parse: parseMock
  }))
}))
vi.mock('@reduxjs/toolkit', () => ({
  nanoid: vi.fn(() => 'test-id')
}))

import { fetchRedirectUrl, fetchWebContent, fetchWebContents } from '../fetch'

// 设置基础 mocks
global.DOMParser = vi.fn().mockImplementation(() => ({
  parseFromString: vi.fn(() => ({}))
})) as any

global.window = {
  api: {
    searchService: {
      openUrlInSearchWindow: vi.fn()
    }
  }
} as any

// 辅助函数
const createMockResponse = (overrides = {}) =>
  ({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('<html><body>Test content</body></html>'),
    ...overrides
  }) as unknown as Response

describe('fetch', () => {
  beforeEach(() => {
    // Mock fetch 和 AbortSignal
    global.fetch = vi.fn()
    global.AbortSignal = {
      timeout: vi.fn(() => ({})),
      any: vi.fn(() => ({}))
    } as any

    // 清理 mock 调用历史
    vi.clearAllMocks()

    // 默认解析结果（用例可用 mockReturnValueOnce 覆盖）
    parseMock.mockReturnValue({
      title: 'Test Article',
      content: '<p>Test content</p>',
      textContent: 'Test content'
    })
    turndownMock.mockReturnValue('# Test content')
  })

  describe('fetchWebContent', () => {
    it('should fetch and return content successfully', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse())

      const result = await fetchWebContent('https://example.com')

      expect(result).toEqual({
        title: 'Test Article',
        url: 'https://example.com',
        content: '# Test content'
      })
      expect(global.fetch).toHaveBeenCalledWith('https://example.com', expect.any(Object))
    })

    it('should use browser mode when specified', async () => {
      vi.mocked(window.api.searchService.openUrlInSearchWindow).mockResolvedValueOnce(
        '<html><body>Browser content</body></html>'
      )

      const result = await fetchWebContent('https://example.com', 'markdown', true)

      expect(result.content).toBe('# Test content')
      expect(window.api.searchService.openUrlInSearchWindow).toHaveBeenCalled()
    })

    // 非取消的失败必须 reject —— 此前它返回 content='No content found' 的"成功"结果，
    // 让引用卡把抓取失败渲染成"页面没有正文"。
    it('rejects instead of faking a no-content success', async () => {
      // 无效 URL
      await expect(fetchWebContent('not-a-url')).rejects.toThrow('Invalid URL format')

      // 网络错误
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'))
      await expect(fetchWebContent('https://example.com')).rejects.toThrow('Network error')

      // HTTP 失败（403 等反爬是引用卡摘要抓取的常态，但仍然是失败）
      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse({ ok: false, status: 403 }))
      await expect(fetchWebContent('https://example.com')).rejects.toThrow('HTTP error: 403')
    })

    it('still reports an empty page body as noContent (fetch succeeded)', async () => {
      parseMock.mockReturnValueOnce({ title: 'Empty', content: '', textContent: '' })
      turndownMock.mockReturnValueOnce('')
      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse())

      const result = await fetchWebContent('https://example.com')

      expect(result.content).toBe('No content found')
    })

    it('should rethrow abort errors', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      vi.mocked(global.fetch).mockRejectedValueOnce(abortError)

      await expect(fetchWebContent('https://example.com')).rejects.toThrow(DOMException)
    })

    it.each([
      ['markdown', '# Test content'],
      ['html', '<p>Test content</p>'],
      ['text', 'Test content']
    ])('should return %s format correctly', async (format, expectedContent) => {
      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse())

      const result = await fetchWebContent('https://example.com', format as any)

      expect(result.content).toBe(expectedContent)
      expect(result.title).toBe('Test Article')
      expect(result.url).toBe('https://example.com')
    })

    it('should handle timeout signal in AbortSignal.any', async () => {
      const mockTimeoutSignal = new AbortController().signal
      vi.spyOn(global.AbortSignal, 'timeout').mockReturnValue(mockTimeoutSignal)

      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse())

      await fetchWebContent('https://example.com')

      // 验证 AbortSignal.timeout 是否被调用，并传入 30000ms
      expect(global.AbortSignal.timeout).toHaveBeenCalledWith(30000)

      vi.spyOn(global.AbortSignal, 'timeout').mockRestore()
    })

    it('should combine user signal with timeout signal', async () => {
      const userController = new AbortController()
      const mockAnyCalls: any[] = []

      vi.spyOn(global.AbortSignal, 'any').mockImplementation((signals) => {
        mockAnyCalls.push(signals)
        return new AbortController().signal
      })

      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse())

      await fetchWebContent('https://example.com', 'markdown', false, {
        signal: userController.signal
      })

      // 验证 AbortSignal.any 是否被调用，并传入两个信号
      expect(mockAnyCalls).toHaveLength(1)
      expect(mockAnyCalls[0]).toHaveLength(2)
      expect(mockAnyCalls[0]).toContain(userController.signal)

      vi.spyOn(global.AbortSignal, 'any').mockRestore()
    })
  })

  describe('fetchWebContents', () => {
    it('should fetch multiple URLs in parallel', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(createMockResponse()).mockResolvedValueOnce(createMockResponse())

      const urls = ['https://example1.com', 'https://example2.com']
      const results = await fetchWebContents(urls)

      expect(results).toHaveLength(2)
      expect(results[0].content).toBe('# Test content')
      expect(results[1].content).toBe('# Test content')
    })

    // 批量抓取不再把单条失败折成成功的 "No content found" 结果；失败向上抛。
    it('rejects when a URL fails instead of disguising it as no content', async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(createMockResponse())
        .mockRejectedValueOnce(new Error('Network error'))

      await expect(fetchWebContents(['https://success.com', 'https://fail.com'])).rejects.toThrow('Network error')
    })
  })

  describe('fetchRedirectUrl', () => {
    it('should return final redirect URL', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        url: 'https://redirected.com/final'
      } as any)

      const result = await fetchRedirectUrl('https://example.com')

      expect(result).toBe('https://redirected.com/final')
      expect(global.fetch).toHaveBeenCalledWith('https://example.com', expect.any(Object))
    })

    it('rejects when the redirect cannot be resolved (: no fake "no redirect" result)', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'))

      await expect(fetchRedirectUrl('https://example.com')).rejects.toThrow('Network error')
    })
  })
})
