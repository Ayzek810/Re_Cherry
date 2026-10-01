/**
 * `StatusIcon` 的自定义 memo 比较器漏掉 `isPreprocessed`（与 `item.uniqueId`）。
 *
 * 缺陷形态：输出依赖这两个输入——`isPreprocessed` 决定 Tooltip 是「预处理完成」还是「嵌入完成」，
 * `item.uniqueId` 决定显示绿勾还是灰点——但比较器不比它们。文件预处理完成（或 store 回填
 * `isPreprocessed`）时比较器判定「props 相等」→ 组件跳过渲染 → 图标与 Tooltip 停留在上一次状态。
 *
 * 行为级断言：把同一幅画的 `isPreprocessed` 从 false 改成 true 重新渲染，图标必须跟着换 Tooltip
 * （旧实现下 re-render 被 memo 吃掉，属性不变）。
 */
import type { KnowledgeBase } from '@renderer/types'
import { render } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

// antd 替身：Tooltip 把 title 落到属性上（断言点），Progress 不参与本用例。
vi.mock('antd', () => ({
  Progress: () => <span data-testid="progress" />,
  Tooltip: ({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) => (
    <span data-tip={String(title)}>{children}</span>
  )
}))

vi.mock('@ant-design/icons', () => ({
  CheckCircleOutlined: () => <span data-testid="check" />,
  CloseCircleOutlined: () => <span data-testid="close" />
}))

import StatusIcon from '../StatusIcon'

const base = (isPreprocessedItem: { uniqueId: string } | null): KnowledgeBase =>
  ({
    id: 'base-1',
    name: 'Demo',
    items: [{ id: 'src-1', type: 'file', ...(isPreprocessedItem ?? ({} as { uniqueId: string })) }]
  }) as unknown as KnowledgeBase

describe('StatusIcon memo 比较器', () => {
  it('isPreprocessed 由 false 变 true 时重渲染并换成「预处理完成」', () => {
    const props = {
      sourceId: 'src-1',
      base: base({ uniqueId: 'u-1' }),
      getProcessingStatus: () => undefined,
      type: 'file'
    }

    const { container, rerender } = render(<StatusIcon {...props} isPreprocessed={false} />)
    expect(container.querySelector('[data-tip]')?.getAttribute('data-tip')).toBe('knowledge.status_embedding_completed')

    rerender(<StatusIcon {...props} isPreprocessed />)
    expect(container.querySelector('[data-tip]')?.getAttribute('data-tip')).toBe(
      'knowledge.status_preprocess_completed'
    )
  })

  it('item.uniqueId 由无到有时重渲染（灰点 → 绿勾）', () => {
    const common = {
      sourceId: 'src-1',
      getProcessingStatus: () => undefined,
      type: 'file'
    }

    const { container, rerender } = render(<StatusIcon {...common} base={base(null)} />)
    expect(container.querySelector('[data-testid="check"]')).toBeNull()

    rerender(<StatusIcon {...common} base={base({ uniqueId: 'u-1' })} />)
    expect(container.querySelector('[data-testid="check"]')).not.toBeNull()
  })
})
