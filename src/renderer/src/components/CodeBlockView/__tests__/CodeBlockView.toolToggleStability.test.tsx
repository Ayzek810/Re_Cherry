/**
 * c2-19 行为测试：展开/换行的 toggle 必须是稳定身份，否则注册 effect 每次渲染
 * 都摘挂一次并向 setTools 写入新数组 —— 自持渲染回路，且每个代码块独立在跑。
 *
 * 缺陷原状：`toggle: useCallback(() => ..., [])` 写在 props 位置，每次渲染都返回新函数。
 */
import { render } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeBlockView } from '../view'

const { expandCalls, wrapCalls, registerToolMock, removeToolMock } = vi.hoisted(() => ({
  expandCalls: [] as any[],
  wrapCalls: [] as any[],
  registerToolMock: vi.fn(),
  removeToolMock: vi.fn()
}))

vi.mock('@renderer/components/CodeToolbar', () => ({
  CodeToolbar: ({ tools }: { tools: unknown[] }) => <div data-testid="toolbar" data-tools={tools.length} />,
  useCopyTool: vi.fn(),
  useDownloadTool: vi.fn(),
  useExpandTool: (props: any) => {
    expandCalls.push(props)
  },
  useRunTool: vi.fn(),
  useSaveTool: vi.fn(),
  useSplitViewTool: vi.fn(),
  useViewSourceTool: vi.fn(),
  useWrapTool: (props: any) => {
    wrapCalls.push(props)
  }
}))

vi.mock('@renderer/components/ActionTools', () => ({
  TOOL_SPECS: {
    expand: { id: 'expand', type: 'quick', order: 12 },
    wrap: { id: 'wrap', type: 'quick', order: 11 }
  },
  useToolManager: () => ({ registerTool: registerToolMock, removeTool: removeToolMock })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    codeEditor: { enabled: false, keymap: true },
    codeExecution: { enabled: false, timeoutMinutes: 1 },
    codeImageTools: false,
    codeCollapsible: true,
    codeWrappable: true
  })
}))

vi.mock('@renderer/components/CodeEditor', () => ({ default: () => <div data-testid="code-editor" /> }))
vi.mock('@renderer/components/CodeViewer', () => ({
  default: ({ onRequestExpand }: { onRequestExpand?: () => void }) => (
    <button type="button" data-testid="code-viewer" onClick={onRequestExpand} />
  )
}))
vi.mock('@renderer/components/ImageViewer', () => ({ default: () => <div /> }))
vi.mock('@renderer/services/PyodideService', () => ({ pyodideService: { runScript: vi.fn() } }))
vi.mock('@renderer/utils/code-language', () => ({ getExtensionByLanguage: () => '.txt' }))
vi.mock('@renderer/utils/fileIconName', () => ({ getFileIconName: () => 'file' }))
vi.mock('@iconify/react', () => ({ Icon: () => <i /> }))

// 保留模块其余导出（i18n/index.ts 依赖 initReactI18next，整体替换会让测试文件加载失败）。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const lastToggle = (calls: any[]) => calls.at(-1)?.toggle

describe('CodeBlockView tool toggles', () => {
  beforeEach(() => {
    expandCalls.length = 0
    wrapCalls.length = 0
    registerToolMock.mockClear()
    removeToolMock.mockClear()
  })

  it('keeps the expand and wrap toggle identities stable across re-renders', () => {
    const { rerender } = render(<CodeBlockView language="text">const a = 1</CodeBlockView>)

    const firstExpand = lastToggle(expandCalls)
    const firstWrap = lastToggle(wrapCalls)
    expect(typeof firstExpand).toBe('function')

    // 重渲染（等价于代码块因任何原因再渲染一次）。
    rerender(<CodeBlockView language="text">const a = 2</CodeBlockView>)
    rerender(<CodeBlockView language="text">const a = 3</CodeBlockView>)

    expect(lastToggle(expandCalls)).toBe(firstExpand)
    expect(lastToggle(wrapCalls)).toBe(firstWrap)
    // 内容变化本身不应触发工具重注册（注册 effect 的依赖里没有内容）。
    expect(registerToolMock).not.toHaveBeenCalled()
  })
})
