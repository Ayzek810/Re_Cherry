import type { TranslationMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import TranslationBlock from '../TranslationBlock'

/**
 * 译文块渲染单测（V1 MessageTranslate 等价物）：
 *   ① 空内容（生成中）→ LoadingIcon 占位、不渲染 Markdown（静默不可见是最坏失败形态）；
 *   ② 有内容 → Markdown 渲染译文、分隔线（翻译图标）存在。
 * Markdown / antd / 图标全部桩注入（对照 ThinkingBlock.test.tsx 模式）。
 */
vi.mock('../../../Markdown/Markdown', () => ({
  default: ({ block }: { block: { content: string } }) => <div data-testid="translation-markdown">{block.content}</div>
}))

vi.mock('antd', () => ({
  Divider: ({ children }: { children?: ReactNode }) => <div data-testid="translation-divider">{children}</div>
}))

vi.mock('@ant-design/icons', () => ({
  TranslationOutlined: () => <span data-testid="translation-icon">译</span>
}))

vi.mock('@renderer/components/Icons', () => ({
  LoadingIcon: () => <span data-testid="translation-loading">loading</span>
}))

function block(overrides: Partial<TranslationMessageBlock> = {}): TranslationMessageBlock {
  return {
    id: 'b-tr',
    messageId: 'm1',
    type: MessageBlockType.TRANSLATION,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: MessageBlockStatus.STREAMING,
    content: '',
    targetLanguage: 'zh-cn',
    ...overrides
  }
}

describe('TranslationBlock', () => {
  it('空内容（生成中）→ LoadingIcon 占位，不渲染 Markdown', () => {
    render(<TranslationBlock block={block()} />)

    expect(screen.getByTestId('translation-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('translation-markdown')).not.toBeInTheDocument()
    expect(screen.getByTestId('translation-divider')).toBeInTheDocument()
  })

  it('有内容 → Markdown 渲染译文 + 分隔线', () => {
    render(<TranslationBlock block={block({ content: '你好，世界', status: MessageBlockStatus.SUCCESS })} />)

    expect(screen.getByTestId('translation-markdown')).toHaveTextContent('你好，世界')
    expect(screen.queryByTestId('translation-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('translation-icon')).toBeInTheDocument()
  })
})
