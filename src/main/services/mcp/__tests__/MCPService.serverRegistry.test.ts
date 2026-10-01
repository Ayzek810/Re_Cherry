/**
 * v1 二轮审查 m2-22 / m2-23 的行为证据（MCPService 客户端注册表投影）。
 *
 * m2-23：`setServers` 的关闭判据此前只是「id 从新表消失」，而 `clients` 的键是配置内容哈希。
 * 编辑服务器（改 command/args/env 是设置页常规操作）时 id 仍在表里，旧 key 的 Client 与它
 * spawn 的 stdio 子进程都不会被关闭。
 * m2-22：`getServerKey` 每调用点逐次 `JSON.stringify`（`emitServerLog` 每个 stderr 分片一次）。
 * 改为 `setServers` 投影期算一次并缓存。
 *
 * 本文件用真 MCPService，只注入 self 一致性对的假 Client + 假传输，直接观测
 * `clients`/`pendingClients`/`serverKeys` 三个内部注册表的状态迁移。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { makeClient } = vi.hoisted(() => {
  type FakeClient = {
    closed: boolean
    close: () => Promise<void>
    connect: () => Promise<void>
    ping: () => Promise<boolean>
    setNotificationHandler: () => void
    listTools: () => Promise<{ tools: unknown[] }>
    listPrompts: () => Promise<{ prompts: unknown[] }>
    listResources: () => Promise<{ resources: unknown[] }>
  }
  const makeClient = (): FakeClient => {
    const client: FakeClient = {
      closed: false,
      close: async () => {
        client.closed = true
      },
      connect: async () => {},
      ping: async () => true,
      setNotificationHandler: () => {},
      listTools: async () => ({ tools: [] }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] })
    }
    return client
  }
  return { makeClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => makeClient())
}))

const connectedTransports = { count: 0 }
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(() => {
    connectedTransports.count++
    return { stderr: { on: vi.fn() } }
  })
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

const { McpService } = await import('../MCPService')

type AnyService = {
  servers: Map<string, unknown>
  serverKeys: Map<string, string>
  clients: Map<string, { closed: boolean }>
  pendingClients: Map<string, unknown>
  logBuffer: { get: (key: string) => unknown }
  setServers: (servers: unknown[]) => void
  getServerKey: (server: { id: string }) => string
}

const server = (overrides: Record<string, unknown> = {}) => ({
  id: 'srv-1',
  name: 'Server One',
  type: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: { A: '1' },
  ...overrides
})

/** 把服务器接成"已连接"：走真 initClient + 假传输，客户端落在 clients[serverKey]。 */
async function connect(service: AnyService, config: Record<string, unknown>) {
  const svc = service as unknown as { initClient: (s: unknown) => Promise<unknown> }
  await svc.initClient(config)
  const key = service.getServerKey(config as { id: string })
  const client = service.clients.get(key)
  expect(client, `client for ${key}`).toBeDefined()
  return { key, client: client! }
}

describe('MCPService 配置注册表投影 (m2-22 / m2-23)', () => {
  let service: AnyService

  beforeEach(() => {
    vi.clearAllMocks()
    connectedTransports.count = 0
    service = McpService.getInstance() as unknown as AnyService
    // 干净起点：清空全部内部注册表（单例跨用例共享）。
    service.servers.clear()
    service.serverKeys.clear()
    service.clients.clear()
    service.pendingClients.clear()
  })

  it('m2-23：配置内容变化（id 不变）时关闭旧客户端并丢弃旧 key 的 pending', async () => {
    const before = server()
    service.setServers([before])
    const { key: oldKey, client: oldClient } = await connect(service, before)
    service.pendingClients.set(oldKey, Promise.resolve(oldClient))

    // 编辑服务器：id 不变，env 变了
    const after = server({ env: { A: '2' } })
    service.setServers([after])

    expect(oldClient.closed).toBe(true)
    expect(service.clients.has(oldKey)).toBe(false)
    expect(service.pendingClients.has(oldKey)).toBe(false)
    expect(service.getServerKey(after)).not.toBe(oldKey)
    expect(service.serverKeys.get('srv-1')).toBe(service.getServerKey(after))
  })

  it('m2-23：id 从新注册表消失时同样关闭旧客户端', async () => {
    const config = server()
    service.setServers([config])
    const { key, client } = await connect(service, config)

    service.setServers([])

    expect(client.closed).toBe(true)
    expect(service.clients.has(key)).toBe(false)
    expect(service.serverKeys.has('srv-1')).toBe(false)
  })

  it('m2-23：配置内容不变时不关客户端（不误伤连接）', async () => {
    const config = server()
    service.setServers([config])
    const { client } = await connect(service, config)

    // 同一内容的新对象（渲染层每次投影都会新建对象）
    service.setServers([server()])

    expect(client.closed).toBe(false)
    expect(service.clients.size).toBe(1)
  })

  it('m2-22：setServers 投影时算一次 key，getServerKey 读缓存（内容相同则键相同）', async () => {
    const first = server()
    service.setServers([first])
    const projected = service.getServerKey(first)

    // 缓存命中：同 id 的不同对象实例返回同一个键，不再逐次 JSON.stringify 出不同结果
    expect(service.serverKeys.get('srv-1')).toBe(projected)
    expect(service.getServerKey({ ...server() })).toBe(projected)
  })

  it('m2-22/23：同步后缓存键随新配置更新（编辑后缓存不复用旧键）', async () => {
    service.setServers([server()])
    const before = service.getServerKey(server())

    service.setServers([server({ command: 'python', args: ['main.py'] })])
    const after = service.getServerKey({ ...server({ command: 'python', args: ['main.py'] }) })

    expect(after).not.toBe(before)
    expect(service.serverKeys.get('srv-1')).toBe(after)
  })
})
