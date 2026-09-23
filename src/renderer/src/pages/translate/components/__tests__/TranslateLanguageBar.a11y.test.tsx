/**
 * 语言栏（`TranslateLanguageBar`）的可访问名契约测试。
 *
 * 行为级验证（§4.18）：V2 `components/TranslateLanguageBar.tsx:166/222` 在源语言/目标语言的
 * 取值渲染里各带一个 `sr-only` 标签（"Source Language" / "Target Language"）。fork 的两个
 * antd Select 此前都没有名字（`TranslateLanguageBar.tsx:55` 两处），屏读时只有"组合框"。
 */
import { render } from '@testing-library/react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'

import TranslateLanguageBar from '../TranslateLanguageBar'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

// 记录每个 Select 收到的 props：测试断言"控件有名字"这一件事，不需要 antd 的弹层。
vi.mock('antd', () => ({
  Select: (props: Record<string, unknown>) => (
    <span
      data-testid={`select-${String(props.value)}`}
      data-aria-label={String(props['aria-label'] ?? '')}
      data-options-count={Array.isArray(props.options) ? props.options.length : 0}
    />
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

const languageLabel = (code: string) => `label:${code}`

describe('TranslateLanguageBar · 可访问名', () => {
  it('源语言与目标语言的控件都有名字（V2 的 sr-only 标签等价物）', () => {
    const { container } = render(
      <TranslateLanguageBar
        source="auto"
        onSourceChange={vi.fn()}
        target="zh-cn"
        onTargetChange={vi.fn()}
        languageLabel={languageLabel}
        exchangeDisabled={false}
        onExchange={vi.fn()}
      />
    )

    const source = container.querySelector('[data-testid="select-auto"]')
    const target = container.querySelector('[data-testid="select-zh-cn"]')

    // 两语的 `translate.source_language` / `translate.target_language` 已补齐（v0.3.3-7），
    // 故两个控件都拿 V2 同名键当可访问名，不再退化成"组合框"。
    expect(source?.getAttribute('data-aria-label')).toBe('translate.source_language')
    expect(target?.getAttribute('data-aria-label')).toBe('translate.target_language')
  })

  it('源语言选项含自动检测 + 全部内置语言，目标语言只含内置语言', () => {
    const { container } = render(
      <TranslateLanguageBar
        source="auto"
        onSourceChange={vi.fn()}
        target="zh-cn"
        onTargetChange={vi.fn()}
        languageLabel={languageLabel}
        exchangeDisabled={false}
        onExchange={vi.fn()}
      />
    )

    const sourceOptions = Number(container.querySelector('[data-testid="select-auto"]')?.getAttribute('data-options-count'))
    const targetOptions = Number(
      container.querySelector('[data-testid="select-zh-cn"]')?.getAttribute('data-options-count')
    )
    expect(sourceOptions).toBe(targetOptions + 1)
  })
})
