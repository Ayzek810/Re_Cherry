import '@renderer/i18n'

import type { PreprocessProvider } from '@renderer/types'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 文档处理页的选中值来源与缺失渲染（v1 二轮审查 s2-11）。
 *
 * 修改前页面把默认 provider 又镜像进一个本地 `useState`，而默认 provider 也被知识库表单等
 * 其他消费者修改，且没有任何 effect 回同步——别处改掉默认 provider 后，本页 Select 仍显示旧值，
 * 用户看到的选择是假的。另一处 `return null` 让「找不到这个 provider」表现为整块消失。
 */

const hooks = vi.hoisted(() => ({
  providers: [] as PreprocessProvider[],
  defaultProvider: undefined as PreprocessProvider | undefined,
  setDefaultPreprocessProvider: vi.fn(),
  singleProvider: undefined as PreprocessProvider | undefined
}))

vi.mock('@renderer/hooks/usePreprocess', () => ({
  usePreprocessProviders: () => ({ preprocessProviders: hooks.providers, updatePreprocessProviders: vi.fn() }),
  useDefaultPreprocessProvider: () => ({
    provider: hooks.defaultProvider,
    setDefaultPreprocessProvider: hooks.setDefaultPreprocessProvider
  }),
  usePreprocessProvider: () => ({ provider: hooks.singleProvider, updateProvider: vi.fn() })
}))

import PreprocessProviderSettings from '../PreprocessProviderSettings'
import PreprocessSettings from '../PreprocessSettings'

const provider = (id: string, name: string): PreprocessProvider => ({ id, name }) as unknown as PreprocessProvider

const selectedLabel = () => document.querySelector('.ant-select-selection-item')?.textContent

beforeEach(() => {
  hooks.setDefaultPreprocessProvider.mockReset()
  hooks.providers = [provider('mistral', 'Mistral'), provider('doc2x', 'Doc2X')]
  hooks.defaultProvider = hooks.providers[0]
  hooks.singleProvider = hooks.providers[0]
})

describe('文档处理 provider 的选中值', () => {
  it('选中值从 redux 派生：外部改掉默认 provider 后本页跟着变（旧实现停在本地草稿）', () => {
    const { rerender } = render(<PreprocessSettings />)
    expect(selectedLabel()).toBe('Mistral')

    hooks.defaultProvider = hooks.providers[1]
    rerender(<PreprocessSettings />)

    expect(selectedLabel()).toBe('Doc2X')
  })

  it('找不到 provider 时渲染显式占位，而不是整块消失', () => {
    hooks.singleProvider = undefined

    render(<PreprocessProviderSettings provider={provider('ghost', 'Ghost')} />)

    expect(screen.getByText(/未找到该文档处理服务商|Document processing provider not found/)).toBeInTheDocument()
  })

  it('provider 存在时正常渲染表单', () => {
    render(<PreprocessProviderSettings provider={provider('mistral', 'Mistral')} />)

    expect(screen.getByText('Mistral')).toBeInTheDocument()
    expect(screen.queryByText(/未找到该文档处理服务商|Document processing provider not found/)).toBeNull()
  })
})
