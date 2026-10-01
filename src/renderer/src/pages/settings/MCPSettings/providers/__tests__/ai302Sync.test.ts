import type { MCPServer } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { syncAi302Servers } from '../302ai'

/**
 * 302.AI 同步结果的收集完整性（v1 二轮审查 s2-05）。
 *
 * 修改前 `allServers` 声明后从未 `push`：`success: true` + 「获取成功」是假成功，
 * 消费方拿到的始终是空数组，面板恒空，还会用空数组覆盖上一次成功拉取的缓存。
 * 五个兄弟 provider（bailian / modelscope / mcprouter / tokenflux / lanyun）都 push 了。
 */

const fetchMock = vi.hoisted(() => vi.fn())

const mcp = (name: string) => ({
  name,
  description: `${name} desc`,
  type: 'streamableHttp',
  baseUrl: `https://x/${name}`
})

const response = (body: unknown, init: { status?: number; ok?: boolean } = {}) => ({
  status: init.status ?? 200,
  ok: init.ok ?? true,
  json: () => Promise.resolve(body)
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('syncAi302Servers 的 allServers 收集', () => {
  it('新增与已存在的服务器都要进 allServers（消费方只读这个字段）', async () => {
    fetchMock.mockResolvedValue(response({ mcps: [mcp('alpha'), mcp('beta')] }))
    const existing = [{ id: '@302ai/beta', name: 'beta' }] as unknown as MCPServer[]

    const result = await syncAi302Servers('token', existing)

    expect(result.success).toBe(true)
    expect(result.addedServers.map((s) => s.id)).toEqual(['@302ai/alpha'])
    expect(result.updatedServers.map((s) => s.id)).toEqual(['@302ai/beta'])
    expect(result.allServers.map((s) => s.id)).toEqual(['@302ai/alpha', '@302ai/beta'])
  })

  it('allServers 恒等于 added + updated（防止再次漏 push）', async () => {
    fetchMock.mockResolvedValue(response({ mcps: [mcp('a'), mcp('b'), mcp('c')] }))
    const existing = [{ id: '@302ai/b' }] as unknown as MCPServer[]

    const result = await syncAi302Servers('token', existing)

    expect(result.allServers).toHaveLength(result.addedServers.length + result.updatedServers.length)
    expect(result.allServers).toHaveLength(3)
  })

  it('远端确实没有服务器时返回空 allServers 且不抛错（这是如实结果，不是失败伪装）', async () => {
    fetchMock.mockResolvedValue(response({ mcps: [] }))

    const result = await syncAi302Servers('token', [])

    expect(result.success).toBe(true)
    expect(result.allServers).toEqual([])
  })

  it('鉴权失败不返回任何服务器（消费方据此不写缓存）', async () => {
    fetchMock.mockResolvedValue(response({}, { status: 401, ok: false }))

    const result = await syncAi302Servers('token', [])

    expect(result.success).toBe(false)
    expect(result.allServers).toEqual([])
  })
})
