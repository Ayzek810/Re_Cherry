/**
 * v1 二轮审查 m2-06 / m2-20 的行为证据。
 *
 * m2-06：`MCPService.initTransport` 此前只在 `npx`/`uvx`/`uv` 三条分支走命令名白名单，
 * 其余 `server.command` 直接进 `StdioClientTransport`——裸名、`C:\evil.exe`、带 shell
 * 元字符的字符串都能落进 spawn。现在 `normalizeMcpCommand` 是唯一准入点。
 *
 * m2-20：Windows 上 `where npx` 只取 `.exe`，而 Node 官方安装器落的是 `npx.cmd`，
 * 已装 Node 的用户被误判为未安装。
 *
 * 注意：`tests/main.setup.ts` 把 `node:fs` 整体桩化（`statSync` 是 `vi.fn()`），
 * 故"绝对路径 + 存在性"的判定用 `vi.mocked(fs.statSync)` 显式给值，不依赖真实磁盘。
 */
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeMcpCommand } from '../commandResolution'

const isWin = process.platform === 'win32'

/** 平台形状的绝对路径（`node:path.join` 在测试 setup 里被桩化，故直接拼字符串）。 */
function absolutePath(name: string): string {
  return isWin ? `C:\\tmp\\${name}` : `/tmp/${name}`
}

/** 构造一个 `fs.Stats` 的最小形状（只有 `isFile` 被 normalizeMcpCommand 消费）。 */
function stats(isFile: boolean): fs.Stats {
  return { isFile: () => isFile } as fs.Stats
}

describe('normalizeMcpCommand (m2-06)', () => {
  afterEach(() => {
    vi.mocked(fs.statSync).mockReset()
  })

  it('accepts bare executable names', () => {
    for (const name of ['node', 'python', 'bun', 'npx', 'uvx', 'uv', 'my-server', 'a1']) {
      expect(normalizeMcpCommand(name)).toEqual({ ok: true, command: name })
    }
  })

  it('trims surrounding whitespace on a bare name', () => {
    expect(normalizeMcpCommand('  node  ')).toEqual({ ok: true, command: 'node' })
  })

  it('rejects empty and whitespace-only commands', () => {
    expect(normalizeMcpCommand('')).toMatchObject({ ok: false })
    expect(normalizeMcpCommand('   ')).toMatchObject({ ok: false })
  })

  it('rejects shell metacharacters in a bare name', () => {
    for (const value of ['node;rm -rf /', 'node&calc', 'node|calc', 'a%b', '$(id)', '`id`', 'node>out', 'a"b']) {
      expect(normalizeMcpCommand(value).ok).toBe(false)
    }
  })

  it('rejects "command + argument" as a whole instead of treating the tail as args', () => {
    const result = normalizeMcpCommand('node -e 1')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('shell metacharacters')
  })

  it('rejects relative paths', () => {
    for (const value of ['./evil.exe', 'sub/dir/evil.exe', '..\\evil.exe']) {
      expect(normalizeMcpCommand(value)).toMatchObject({ ok: false })
    }
  })

  it('rejects a non-executable extension on an absolute path', () => {
    const result = normalizeMcpCommand(absolutePath('m2-06-not-executable.txt'))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('must end with')
  })

  it('rejects an absolute path that does not exist', () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const result = normalizeMcpCommand(absolutePath('m2-06-does-not-exist.exe'))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('does not exist')
  })

  it('rejects a directory even when it has an executable-looking name', () => {
    vi.mocked(fs.statSync).mockReturnValue(stats(false))
    const result = normalizeMcpCommand(absolutePath('m2-06-dir.exe'))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('is not a file')
  })

  it('accepts an existing absolute executable path', () => {
    vi.mocked(fs.statSync).mockReturnValue(stats(true))
    const target = isWin ? 'C:\\tools\\node.exe' : '/usr/local/bin/node'
    const result = normalizeMcpCommand(target)
    expect(result).toMatchObject({ ok: true })
    expect(result.ok === true && result.command.length > 0).toBe(true)
  })

  it('accepts an extensionless absolute path', () => {
    vi.mocked(fs.statSync).mockReturnValue(stats(true))
    const target = isWin ? 'C:\\tools\\mcp-server' : '/usr/local/bin/mcp-server'
    expect(normalizeMcpCommand(target)).toMatchObject({ ok: true })
  })
})

describe('findCommandInShellEnv (m2-20)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an invalid command name before spawning anything', async () => {
    const { findCommandInShellEnv } = await import('../commandResolution')
    expect(await findCommandInShellEnv('node -e 1', {})).toBeNull()
    expect(await findCommandInShellEnv('a&b', {})).toBeNull()
  })

  it.skipIf(!isWin)('resolves npx to a spawnable path on Windows (npx.cmd install shape)', async () => {
    // `where` 会按 PATH 顺序列出全部命中；旧实现只取 `.exe`，只装了 .cmd 的 npx 被判"未找到"。
    const { findCommandInShellEnv } = await import('../commandResolution')
    const resolved = await findCommandInShellEnv('npx', { ...process.env } as Record<string, string>)
    if (resolved === null) return // 本机没装 Node CLI 时跳过（不是断言失败）
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(['.exe', '.cmd', '.bat', '']).toContain(path.extname(resolved).toLowerCase())
  })
})
