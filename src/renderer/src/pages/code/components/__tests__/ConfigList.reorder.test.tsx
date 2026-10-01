/**
 * 拖拽把手渲染出来但拖拽排序被 shim 丢弃。
 *
 * `ReorderableList` 不实现拖拽（`void onReorder`、`dragging` 恒 false），卡片上却有一个
 * `cursor-grab` 的把手、`ConfigList` 也按 V2 形状消费 `dragging`——"渲染承诺了交互但语义为空"，
 * 用户按住把手拖动毫无反应，而且唯一的排序入口（"置顶"）只在 hover 时才出现。
 *
 * 当前服务商卡片的模型名在"配置不匹配"时被替换成字面量「未知供应商」——
 * 选中卡片的第二行于是显示"我选的服务商 = 未知供应商"。
 *
 * 行为级断言：
 *   ① 卡片刻意**不再**渲染拖拽把手（没有 `cursor-grab`）；
 *   ② "置顶"按钮常显（不在 `opacity-0` 容器里），点击后 onReorder 真正拿到重排结果；
 *   ③ 卡片模型名取 `resolveMeta`，不再出现「未知供应商」占位。
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Provider } from '../../cliConfig/providerView'
import { ConfigList } from '../ConfigList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

vi.mock('@renderer/pages/code/cliConfig', () => ({
  isOwnLoginConfigurable: () => true
}))

vi.mock('@renderer/components/ProviderAvatar', () => ({
  ProviderAvatarPrimitive: () => <span data-testid="provider-avatar" />
}))

// 用 `vi.importActual` 拿真实模块：`importOriginal()` 的返回类型是 `Promise<unknown>`，
// 展开前必须窄化，而窄化又需要 `typeof import()` 注解（被 consistent-type-imports 禁）。
// 这里只声明本测试真正需要保留的那个导出，零断言、零 lint 冲突。
vi.mock('@renderer/config/providers', async () => {
  const actual = await vi.importActual<{ getProviderLogo: (providerId: string) => string | undefined }>(
    '@renderer/config/providers'
  )
  return { ...actual, getProviderLogo: () => undefined }
})

function makeProvider(id: string, name: string): Provider {
  return {
    id,
    name,
    endpointConfigs: { 'openai-chat-completions': { baseUrl: 'https://api.example.com' } },
    apiKeys: [{ id: 'default', key: 'sk-live', isEnabled: true }],
    models: []
  }
}

const providers = [makeProvider('provider-1', 'Provider One'), makeProvider('provider-2', 'Provider Two')]

const resolveMeta = (provider: Provider) => ({
  providerName: provider.name,
  modelName: `${provider.id}-model`
})

function renderList(overrides: Partial<Parameters<typeof ConfigList>[0]> = {}) {
  const onReorder = vi.fn()
  const result = render(
    <ConfigList
      selectedCliTool={'deepseek-harness' as never}
      toolName="DeepSeek Harness"
      providers={providers}
      providerConfigs={{}}
      currentProviderId="provider-1"
      resolveMeta={resolveMeta}
      onConfigure={vi.fn()}
      onToggleCurrent={vi.fn()}
      onReorder={onReorder}
      {...overrides}
    />
  )
  return { onReorder, ...result }
}

describe('ConfigList（去掉假拖拽通道 + 常显置顶：模型名不再被替换）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  it('卡片上不再有 cursor-grab 拖拽把手（不承诺未实现的交互）', () => {
    const { container } = renderList()

    expect(container.querySelector('.cursor-grab')).toBeNull()
    expect(container.querySelector('.lucide-grip-vertical')).toBeNull()
  })

  it('“置顶”按钮常显，点击后 onReorder 拿到真正重排的数组', () => {
    const { onReorder } = renderList()

    // 首项没有置顶按钮，故只有第二项有——但它必须是可见的（旧的 hover 才显示）。
    const moveToTop = screen.getByLabelText('code.move_provider_to_top')
    expect(moveToTop.closest('.opacity-0')).toBeNull()

    moveToTop.click()

    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0][0].map((provider: Provider) => provider.id)).toEqual(['provider-2', 'provider-1'])
  })

  it('providerActionsDisabled 时不提供置顶入口（动作禁用语义不变）', () => {
    renderList({ providerActionsDisabled: true })

    expect(screen.queryByLabelText('code.move_provider_to_top')).toBeNull()
  })

  it('当前服务商卡片的模型名来自 resolveMeta，不是「未知供应商」占位', () => {
    const { container } = renderList()

    expect(container.textContent).toContain('provider-1-model')
    expect(container.textContent).toContain('provider-2-model')
    expect(container.textContent).not.toContain('code.cli_config.unknown_provider')
  })
})
