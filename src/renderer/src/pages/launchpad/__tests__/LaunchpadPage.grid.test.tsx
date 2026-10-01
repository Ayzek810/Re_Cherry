/**
 * 二轮审查 f2-62：启动台入口卡片已增至 7 个，但网格仍写死 6 列。
 *
 * 行为级断言：网格的列定义必须与入口数量的变化解耦（不再写死 `repeat(6, 1fr)`），
 * 并且 7 个入口全部渲染出来（不是被列数限制掉）。
 *
 * v1（W4-3）追加：列定义必须是 `auto-fill` 而不是 `auto-fit`——两个区块共用同一网格样式，
 * 而 `auto-fit` 会折叠空轨道、把宽度平摊给少量条目，"小程序"区 3 个磁贴因此被摊开成三格宽
 * （真机实测 x≈236/469/702，而 7 个入口的"应用"区是 x≈177/289/… 的左排）。
 */
import '@renderer/i18n'

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

/** 可变替身：同一文件内按用例切换"没有小程序 / 有三个固定小程序"。 */
const minappsMock: { pinned: Array<{ id: string }> } = { pinned: [] }
vi.mock('@renderer/hooks/useMinapps', () => ({ useMinapps: () => minappsMock }))
vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ openedKeepAliveMinapps: [] }) }))
vi.mock('@renderer/components/MinApp/MinApp', () => ({ default: () => <div data-testid="minapp-tile" /> }))

import LaunchpadPage from '../LaunchpadPage'

/** 带 `styled-components` 生成的类名的容器：全部 `display: grid` 的元素。 */
function gridElements(): HTMLElement[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('div'))
  const grids = nodes.filter((node) => getComputedStyle(node).display === 'grid')
  if (grids.length === 0) throw new Error('launchpad grid not found')
  return grids
}

function gridElement(): HTMLElement {
  return gridElements()[0]
}

describe('LaunchpadPage 网格列定义（f2-62）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    minappsMock.pinned = []
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

  it('W4-3：小程序区与入口区同列定义，且用 auto-fill（少量条目不摊开）', () => {
    minappsMock.pinned = [{ id: 'deepseek' }, { id: 'zai' }, { id: 'huggingchat' }]
    render(<LaunchpadPage />)

    const grids = gridElements()
    // 入口区 + 小程序区（两个区块共用同一 Grid 样式）
    expect(grids).toHaveLength(2)
    const templates = grids.map((node) => getComputedStyle(node).gridTemplateColumns)
    for (const template of templates) {
      expect(template).toContain('auto-fill')
      // `auto-fit` 折叠空轨道 ⇒ 3 个小程序各占 ~229px 被摊开（W4-3 真机截图）。
      expect(template).not.toContain('auto-fit')
    }
    expect(templates[0]).toBe(templates[1])
  })
})
