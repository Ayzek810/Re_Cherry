/**
 * 二轮审查 f2-44：DSH 服务商过滤的"凭据臂"恒真。
 *
 * `toCliProvider`（cliConfig/providerView.ts:124）投影出的 `apiKeys` 是
 * `[{ id: 'default', key: provider.apiKey ?? '', isEnabled: true }]`——`isEnabled` 硬编码 true，
 * 未配 key 的服务商 key 是空串。旧判据只看 `isEnabled`，于是谓词恒真：用户能在 DSH 页选中一个
 * 未配 key 的服务商，直到启动时才在主进程侧撞上
 * `Provider … has no enabled API key`（DeepSeekHarnessService.ts:370）。
 *
 * 行为级断言：判据落在 key 值上（含投影层的端到端形态）。
 */
import { CodeCli } from '@shared/types/codeCli'
import { describe, expect, it } from 'vitest'

import type { Provider } from '../../cliConfig/providerView'
import { toCliProvider } from '../../cliConfig/providerView'
import { CLI_TOOL_PROVIDER_MAP } from '../cliTools'

const filter = CLI_TOOL_PROVIDER_MAP[CodeCli.DEEPSEEK_HARNESS]

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'Provider 1',
    endpointConfigs: { 'openai-chat-completions': { baseUrl: 'https://api.example.com' } },
    apiKeys: [{ id: 'default', key: 'sk-live', isEnabled: true }],
    models: [],
    ...overrides
  }
}

describe('CLI_TOOL_PROVIDER_MAP[DEEPSEEK_HARNESS]（f2-44：凭据臂按 key 值判定）', () => {
  it('有启用且非空的 key + 可注入端点 ⇒ 进入列表', () => {
    expect(filter([makeProvider()])).toHaveLength(1)
  })

  it('key 为空串（未配 key 的服务商）⇒ 不进入列表', () => {
    const unconfigured = makeProvider({ apiKeys: [{ id: 'default', key: '', isEnabled: true }] })
    // 旧判据（只看 isEnabled）在这里返回长度 1 —— 这就是缺陷。
    expect(filter([unconfigured])).toHaveLength(0)
  })

  it('key 只有空白 ⇒ 不进入列表', () => {
    const blank = makeProvider({ apiKeys: [{ id: 'default', key: '   ', isEnabled: true }] })
    expect(filter([blank])).toHaveLength(0)
  })

  it('key 有值但被禁用 ⇒ 不进入列表', () => {
    const disabled = makeProvider({ apiKeys: [{ id: 'default', key: 'sk-live', isEnabled: false }] })
    expect(filter([disabled])).toHaveLength(0)
  })

  it('无 key 的服务商经 toCliProvider 投影后同样被滤掉（投影硬编码 isEnabled=true）', () => {
    const forkProviderWithoutKey = {
      id: 'ollama',
      name: 'Ollama',
      apiHost: 'http://127.0.0.1:11434',
      apiKey: '',
      models: []
    }

    const projected = toCliProvider(forkProviderWithoutKey as unknown as Parameters<typeof toCliProvider>[0])

    // 投影事实：isEnabled 恒 true、key 为空 —— 凭据臂必须看 key 值。
    expect(projected.apiKeys).toEqual([{ id: 'default', key: '', isEnabled: true }])
    expect(filter([projected])).toHaveLength(0)

    // 反向对照：同一个服务商配上 key 后必须进入列表。
    const configured = toCliProvider({
      ...forkProviderWithoutKey,
      apiKey: 'sk-live'
    } as unknown as Parameters<typeof toCliProvider>[0])
    expect(filter([configured])).toHaveLength(1)
  })

  it('登录型服务商与无可用端点的服务商仍被滤掉（原有两条臂不变）', () => {
    const loginBased = makeProvider({ authMethods: ['oauth'] })
    const withoutEndpoint = makeProvider({ id: 'no-endpoint', endpointConfigs: {} })

    expect(filter([loginBased])).toHaveLength(0)
    expect(filter([withoutEndpoint])).toHaveLength(0)
  })

  it('anthropic 端点型服务商（有 key）仍然进入列表', () => {
    const anthropicOnly = makeProvider({
      id: 'anthropic-only',
      endpointConfigs: { 'anthropic-messages': { baseUrl: 'https://api.anthropic.com' } }
    })
    expect(filter([anthropicOnly])).toHaveLength(1)
  })
})
