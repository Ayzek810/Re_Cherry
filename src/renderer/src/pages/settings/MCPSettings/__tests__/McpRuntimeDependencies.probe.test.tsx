import '@renderer/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 运行时命令探测的第三态（v1 二轮审查 s2-26）。
 *
 * `probeMcpRuntimeCommands` 把「IPC 探测失败」与「命令确实不在 PATH」都折叠成 `null`，
 * 而 UI 之前只保留后者：探测无应答被渲染成红框「依赖缺失」，用户会去重装已装好的工具。
 * 这里锁住修正后的语义：复核探测抛错 = 「暂时无法探测」，不是「缺失」。
 */

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  checkCommand: vi.fn()
}))

vi.mock('@renderer/services/mcpApi', () => ({
  MCP_RUNTIME_COMMANDS: ['npx', 'uvx'],
  probeMcpRuntimeCommands: mocks.probe,
  mcpApi: { checkCommand: mocks.checkCommand }
}))

import McpRuntimeDependencies from '../McpRuntimeDependencies'

const UNKNOWN = /暂时无法探测 npx|Cannot probe npx right now/
const MISSING = /npx 未在系统 PATH 中找到|npx was not found in the system PATH/

const renderPanel = () =>
  render(
    <MemoryRouter>
      <McpRuntimeDependencies />
    </MemoryRouter>
  )

beforeEach(() => {
  mocks.probe.mockReset()
  mocks.checkCommand.mockReset()
})

describe('MCP 运行时依赖页的探测失败态', () => {
  it('探测抛错渲染「无法探测」而不是「缺失」', async () => {
    mocks.probe.mockResolvedValue({ npx: null, uvx: '/usr/bin/uvx' })
    mocks.checkCommand.mockRejectedValue(new Error('ipc down'))

    renderPanel()

    await waitFor(() => expect(screen.getByText(UNKNOWN)).toBeInTheDocument())
    expect(screen.queryByText(MISSING)).toBeNull()
  })

  it('复核仍然返回 null 才算真的缺失', async () => {
    mocks.probe.mockResolvedValue({ npx: null, uvx: '/usr/bin/uvx' })
    mocks.checkCommand.mockResolvedValue(null)

    renderPanel()

    await waitFor(() => expect(screen.getByText(MISSING)).toBeInTheDocument())
    expect(screen.queryByText(UNKNOWN)).toBeNull()
  })

  it('探测成功的命令显示绝对路径，且不再重复探测', async () => {
    mocks.probe.mockResolvedValue({ npx: '/usr/local/bin/npx', uvx: '/usr/local/bin/uvx' })

    renderPanel()

    await waitFor(() => expect(screen.getByText('/usr/local/bin/npx')).toBeInTheDocument())
    expect(mocks.checkCommand).not.toHaveBeenCalled()
  })
})
