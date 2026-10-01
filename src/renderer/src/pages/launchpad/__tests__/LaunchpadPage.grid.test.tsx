/**
 * 二轮审查 f2-62：启动台入口卡片已增至 7 个，但网格仍写死 6 列。
 *
 * 行为级断言：网格的列定义必须与入口数量的变化解耦（不再写死 `repeat(6, 1fr)`），
 * 并且 7 个入口全部渲染出来（不是被列数限制掉）。
 */
import '@renderer/i18n'

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@renderer/hooks/useMinapps', () => ({ useMinapps: () => ({ pinned: [] }) }))
vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ openedKeepAliveMinapps: [] }) }))
vi.mock('@renderer/components/MinApp/MinApp', () => ({ default: () => <div data-testid="minapp-tile" /> }))

import LaunchpadPage from '../LaunchpadPage'

/** 带 `styled-components` 生成的类名的容器：取第一个 `display: grid` 的元素。 */
function gridElement(): HTMLElement {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('div'))
  const grid = nodes.find((node) => getComputedStyle(node).display === 'grid')
  if (!grid) throw new Error('launchpad grid not found')
  return grid
}

describe('LaunchpadPage 网格列定义（f2-62）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('列定义不再写死 6 列，且 7 个入口全部渲染', () => {
    render(<LaunchpadPage />)

    // jsdom 会把 `grid-template-columns` 原样回读（不做 calc 求值）。
    const columns = getComputedStyle(gridElement()).gridTemplateColumns
    expect(columns.length).toBeGreaterThan(0)
    // 旧实现是 `repeat(6, 1fr)`：7 个磁贴会在第二行只剩 1 个靠左的磁贴。
    expect(columns).not.toContain('repeat(6')

    // 七张入口卡片（小程序 / 知识库 / 文件 / 翻译 / 绘画 / 笔记 / 编码助手）都要在。
    const labels = Array.from(document.querySelectorAll('div'))
      .filter((node) => node.children.length === 0)
      .map((node) => node.textContent ?? '')
    for (const label of ['Apps', 'Knowledge Base', 'Files', 'Translate', 'Paintings', 'Notes', 'Code Mate']) {
      expect(labels).toContain(label)
    }
  })
})
