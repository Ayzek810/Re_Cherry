import { beforeEach, describe, expect, it, vi } from 'vitest'

/** markdown-it 实例：`use` 的记录器就是本用例要钉住的契约。 */
const useMock = vi.fn()
const renderMock = vi.fn(() => '<p>rendered</p>')

vi.mock('markdown-it', () => ({
  default: vi.fn(() => ({
    use: useMock,
    render: renderMock
  }))
}))

const fromHighlighterMock = vi.fn(
  (_highlighter: unknown, _options: { themes: Record<string, string> }) => 'shiki-plugin'
)

vi.mock('@shikijs/markdown-it/core', () => ({
  fromHighlighter: fromHighlighterMock
}))

/**
 * r2-77 行为契约：`getMarkdownIt` 每次都返回**同一个** markdown-it 实例，且
 * `md.use()` 只执行一次（插件在模块级单例的工厂里装配）。
 * 此前 `md.use(fromHighlighter(...))` 写在 `getMarkdownIt` 里，每次调用都往同一实例
 * 追加一份高亮插件，插件数/内存/单次 render 的 CPU 随调用次数线性增长。
 */
describe('utils/shiki getMarkdownIt (r2-77)', () => {
  beforeEach(() => {
    vi.resetModules()
    useMock.mockClear()
    fromHighlighterMock.mockClear()

    vi.doMock('shiki', () => ({
      createHighlighter: async () => ({
        getLoadedLanguages: () => ['text', 'javascript', 'typescript', 'python', 'java', 'markdown', 'json'],
        getLoadedThemes: () => ['one-light', 'material-theme-darker'],
        loadLanguage: vi.fn(),
        loadTheme: vi.fn()
      })
    }))
  })

  it('registers the highlighter plugin exactly once across repeated calls', async () => {
    const { getMarkdownIt } = await import('../shiki')

    const first = await getMarkdownIt('one-light', '```ts\nconst a = 1\n```')
    const second = await getMarkdownIt('one-light', '```ts\nconst b = 2\n```')
    const third = await getMarkdownIt('material-theme-darker', '```js\nlet c = 3\n```')

    expect(useMock).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('passes the current theme through to the (single) plugin registration', async () => {
    const { getMarkdownIt } = await import('../shiki')

    await getMarkdownIt('material-theme-darker', 'plain text')

    expect(fromHighlighterMock).toHaveBeenCalledTimes(1)
    const options = fromHighlighterMock.mock.calls[0]?.[1]
    expect(options).toBeDefined()
    expect(Object.keys(options.themes)).toContain('material-theme-darker')
    expect(options.themes['material-theme-darker']).toBe('material-theme-darker')
  })
})
