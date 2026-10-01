/**
 * DxtService 测试（v0.4.7 自上游 DxtService.test.ts 移植 + fork 扩展）。
 *
 * 纯函数（ensurePathWithin/validateCommand/validateArgs）用例同上游；uploadDxt /
 * getResolvedMcpConfig / cleanupDxtServerByPath 为真 fs 集成测试：fixtures 用 archiver
 * （既有运行期依赖）在临时目录现做 .dxt（zip）包，服务实例注入 tempDir/mcpDir。
 * 主测试 setup 全局 mock 了 node:fs/node:path/node:os——本文件整体还原真实现
 *（pdfExtractBridge.test.ts 同款 importOriginal 局部覆写惯例）。
 */
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

// setup 层把 node:fs/path/os 换成了空壳 vi.fn()——本文件要真 fs，先还原。
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})

import archiver from 'archiver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import DxtService, { applyPlatformOverrides, ensurePathWithin, validateArgs, validateCommand } from '../DxtService'

const TEMP_BASE = path.join(process.cwd(), '.tmp-dxt-service-tests')

let tempRoot: string
let mcpDir: string

beforeAll(async () => {
  await fs.promises.mkdir(TEMP_BASE, { recursive: true })
  tempRoot = await fs.promises.mkdtemp(path.join(TEMP_BASE, 'uploads-'))
  mcpDir = await fs.promises.mkdtemp(path.join(TEMP_BASE, 'mcp-'))
})

afterAll(async () => {
  await fs.promises.rm(TEMP_BASE, { recursive: true, force: true })
})

const makeService = () => new DxtService({ tempDir: tempRoot, mcpDir })

/** 用 archiver 现做一个 .dxt（zip）包。 */
async function buildDxt(filePath: string, files: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(filePath)
    const archive = archiver('zip')
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name })
    }
    void archive.finalize()
  })
}

const validManifest = {
  dxt_version: '0.1',
  name: 'test-server',
  display_name: 'Test Server',
  version: '1.0.0',
  description: 'A test DXT server',
  server: {
    type: 'python',
    entry_point: 'server/server.py',
    mcp_config: {
      command: 'python',
      args: ['${__dirname}/server/server.py', '--port', '8080'],
      env: { TEST_VAR: '${HOME}/data' }
    }
  }
}

describe('ensurePathWithin', () => {
  const baseDir = path.join(os.tmpdir(), 'dxt-base')

  it('接受直系子目录路径', () => {
    const target = path.join(baseDir, 'server-test')
    expect(ensurePathWithin(baseDir, target)).toBe(path.resolve(target))
  })

  it('接受含 unicode 字符的直系子目录', () => {
    const target = path.join(baseDir, '服务器')
    expect(ensurePathWithin(baseDir, target)).toBe(path.resolve(target))
  })

  it('拒绝逃出基目录的穿越路径', () => {
    expect(() => ensurePathWithin(baseDir, path.join(baseDir, '..', '..', '..', 'etc'))).toThrow(
      'Path traversal detected'
    )
    expect(() => ensurePathWithin(baseDir, '/etc/passwd')).toThrow('Path traversal detected')
  })

  it('拒绝子目录嵌套（只允许直系子目录）', () => {
    expect(() => ensurePathWithin(baseDir, path.join(baseDir, 'sub', 'dir'))).toThrow('Path traversal detected')
  })

  it('拒绝 Windows 风格穿越', () => {
    expect(() => ensurePathWithin('C:\\Users\\user\\mcp', 'C:\\Users\\user\\mcp\\..\\..\\Windows\\System32')).toThrow(
      'Path traversal detected'
    )
  })

  it('拒绝 null 字节路径', () => {
    const maliciousPath = path.join(baseDir, 'server\x00/../../../etc/passwd')
    expect(() => ensurePathWithin(baseDir, maliciousPath)).toThrow('Path traversal detected')
  })

  it('拒绝基目录本身', () => {
    expect(() => ensurePathWithin(baseDir, baseDir)).toThrow('Path traversal detected')
  })
})

describe('validateCommand', () => {
  it('接受简单命令名与绝对路径', () => {
    expect(validateCommand('node')).toBe('node')
    expect(validateCommand('npx')).toBe('npx')
    expect(validateCommand('/usr/bin/node')).toBe('/usr/bin/node')
    expect(validateCommand('C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('接受 ./ 开头的相对路径并去首尾空白', () => {
    expect(validateCommand('./node_modules/.bin/tsc')).toBe('./node_modules/.bin/tsc')
    expect(validateCommand('  node  ')).toBe('node')
  })

  it('拒绝含路径穿越的命令', () => {
    expect(() => validateCommand('../../../bin/sh')).toThrow('path traversal detected')
    expect(() => validateCommand('..\\..\\..\\Windows\\System32\\cmd.exe')).toThrow('path traversal detected')
    expect(() => validateCommand('..')).toThrow('path traversal detected')
    expect(() => validateCommand('../..\\mixed/..\\attack')).toThrow('path traversal detected')
  })

  it('拒绝 null 字节与空值', () => {
    expect(() => validateCommand('node\x00.exe')).toThrow('null byte detected')
    expect(() => validateCommand('')).toThrow('command must be a non-empty string')
    expect(() => validateCommand('   ')).toThrow('command cannot be empty')
    expect(() => validateCommand(undefined as unknown as string)).toThrow('command must be a non-empty string')
  })
})

describe('validateArgs', () => {
  it('接受正常参数与安全路径', () => {
    expect(validateArgs(['--version'])).toEqual(['--version'])
    expect(validateArgs(['-y', '@anthropic/mcp-server'])).toEqual(['-y', '@anthropic/mcp-server'])
    expect(validateArgs(['./src/index.ts'])).toEqual(['./src/index.ts'])
    expect(validateArgs([])).toEqual([])
  })

  it('只对含路径分隔符的参数做穿越校验', () => {
    expect(() => validateArgs(['../../../etc/passwd'])).toThrow('path traversal detected')
    expect(() => validateArgs(['..\\..\\Windows\\System32\\config'])).toThrow('path traversal detected')
    // 无路径分隔符的 .. 开头参数不误伤
    expect(validateArgs(['..version'])).toEqual(['..version'])
    expect(validateArgs(['test..name'])).toEqual(['test..name'])
  })

  it('拒绝 null 字节与非字符串元素', () => {
    expect(() => validateArgs(['file\x00.txt'])).toThrow('null byte detected')
    expect(() => validateArgs([123 as unknown as string])).toThrow('must be a string')
    expect(() => validateArgs('not an array' as unknown as string[])).toThrow('must be an array')
  })
})

describe('performVariableSubstitution', () => {
  it('替换 ${__dirname}/${HOME}/${pathSeparator}', () => {
    const dir = path.join(os.tmpdir(), 'extract')
    // ${__dirname} 是纯字符串替换：manifest 里的 `server/server.py` 段保持原样（上游同语义）
    expect(applyPlatformOverrides(validManifest.server.mcp_config, dir).args[0]).toBe(`${dir}/server/server.py`)
    expect(applyPlatformOverrides(validManifest.server.mcp_config, dir).env?.TEST_VAR).toBe(`${os.homedir()}/data`)
  })

  it('替换 ${user_config.KEY}，未配置保留原文', () => {
    const config = { command: 'node', args: ['${user_config.apiKey}'] }
    const withValue = applyPlatformOverrides(config, '/d', { apiKey: 'k-123' })
    expect(withValue.args).toEqual(['k-123'])
    const withoutValue = applyPlatformOverrides(config, '/d')
    expect(withoutValue.args).toEqual(['${user_config.apiKey}'])
  })

  it('应用当前平台覆写并合并 env', () => {
    const override = { command: 'python3', args: ['-u', 'main.py'], env: { EXTRA: '1' } }
    const config = {
      command: 'python',
      args: ['main.py'],
      env: { BASE: '0' },
      platform_overrides: { [process.platform]: override }
    }
    const resolved = applyPlatformOverrides(config, '/d')
    expect(resolved.command).toBe('python3')
    expect(resolved.args).toEqual(['-u', 'main.py'])
    expect(resolved.env).toEqual({ BASE: '0', EXTRA: '1' })
  })
})

describe('uploadDxt', () => {
  it('成功解包并落位 mcpDir/server-{name}，manifest 原样返回', async () => {
    const dxtPath = path.join(tempRoot, 'valid.dxt')
    await buildDxt(dxtPath, {
      'manifest.json': JSON.stringify(validManifest),
      'server/server.py': 'print("hi")'
    })

    const result = await makeService().uploadDxt(dxtPath)
    expect(result.success).toBe(true)
    expect(result.data?.manifest).toEqual(validManifest)
    expect(result.data?.extractDir).toBe(path.join(mcpDir, 'server-test-server'))

    const extractDir = result.data?.extractDir
    expect(extractDir).toBeDefined()
    expect(fs.existsSync(path.join(extractDir!, 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(extractDir!, 'server', 'server.py'))).toBe(true)
  })

  it('重装同名服务器时替换旧目录', async () => {
    const dxtPath = path.join(tempRoot, 'reinstall.dxt')
    // 第一轮：带运行文件
    await buildDxt(dxtPath, {
      'manifest.json': JSON.stringify(validManifest),
      'server/server.py': 'print("hi")'
    })

    const first = await makeService().uploadDxt(dxtPath)
    expect(first.success).toBe(true)
    const marker = path.join(first.data!.extractDir, 'server', 'server.py')
    expect(fs.existsSync(marker)).toBe(true)

    // 第二轮：同名重装，包里不再带 server.py → 旧目录整体替换，旧文件消失
    await buildDxt(dxtPath, { 'manifest.json': JSON.stringify(validManifest) })

    const second = await makeService().uploadDxt(dxtPath)
    expect(second.success).toBe(true)
    expect(second.data!.extractDir).toBe(first.data!.extractDir)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(path.join(second.data!.extractDir, 'manifest.json'))).toBe(true)
  })

  it('缺 manifest.json 如实报错', async () => {
    const dxtPath = path.join(tempRoot, 'no-manifest.dxt')
    await buildDxt(dxtPath, { 'README.md': 'nothing here' })

    const result = await makeService().uploadDxt(dxtPath)
    expect(result.success).toBe(false)
    expect(result.error).toBe('manifest.json not found in DXT file')
    // 失败不留半成品：临时解包目录被清掉
    const leftover = fs.readdirSync(tempRoot).filter((name) => name.startsWith('dxt_'))
    expect(leftover).toEqual([])
  })

  it('manifest 缺字段逐项具名报错', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: 'x', version: '1', server: { mcp_config: { command: 'a', args: [] } } }, 'missing dxt_version'],
      [{ dxt_version: '0.1', version: '1', server: { mcp_config: { command: 'a', args: [] } } }, 'missing name'],
      [{ dxt_version: '0.1', name: 'x', server: { mcp_config: { command: 'a', args: [] } } }, 'missing version'],
      [{ dxt_version: '0.1', name: 'x', version: '1' }, 'missing server configuration'],
      [{ dxt_version: '0.1', name: 'x', version: '1', server: {} }, 'missing server.mcp_config'],
      [
        { dxt_version: '0.1', name: 'x', version: '1', server: { mcp_config: { args: [] } } },
        'missing server.mcp_config.command'
      ],
      [
        { dxt_version: '0.1', name: 'x', version: '1', server: { mcp_config: { command: 'a' } } },
        'args must be an array'
      ]
    ]
    for (const [manifest, expectedError] of cases) {
      const dxtPath = path.join(tempRoot, `invalid-${expectedError.replace(/\W+/g, '-')}.dxt`)
      await buildDxt(dxtPath, { 'manifest.json': JSON.stringify(manifest) })
      const result = await makeService().uploadDxt(dxtPath)
      expect(result.success, expectedError).toBe(false)
      expect(result.error, expectedError).toContain(expectedError)
    }
  })

  it('manifest.name 含路径穿越时拒绝落位', async () => {
    const dxtPath = path.join(tempRoot, 'evil-name.dxt')
    await buildDxt(dxtPath, {
      'manifest.json': JSON.stringify({ ...validManifest, name: '../../../evil' })
    })

    const result = await makeService().uploadDxt(dxtPath)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Path traversal detected')
    // mcpDir 内不得出现逃逸目录
    expect(fs.existsSync(path.join(mcpDir, '..', 'evil'))).toBe(false)
  })

  it('源文件不存在如实报错', async () => {
    const result = await makeService().uploadDxt(path.join(tempRoot, 'missing.dxt'))
    expect(result.success).toBe(false)
    expect(result.error).toBe('DXT file not found')
  })
})

describe('getResolvedMcpConfig', () => {
  it('按解包目录重解配置（平台覆写 + 变量替换）', async () => {
    const extractDir = path.join(mcpDir, 'server-resolve-test')
    fs.mkdirSync(extractDir, { recursive: true })
    const manifest = {
      ...validManifest,
      server: {
        ...validManifest.server,
        mcp_config: {
          ...validManifest.server.mcp_config,
          platform_overrides: {
            [process.platform]: { command: 'python3', env: { PLATFORM_VAR: 'yes' } }
          }
        }
      }
    }
    fs.writeFileSync(path.join(extractDir, 'manifest.json'), JSON.stringify(manifest))

    const resolved = makeService().getResolvedMcpConfig(extractDir)
    expect(resolved).not.toBeNull()
    expect(resolved!.command).toBe('python3')
    expect(resolved!.args[0]).toBe(`${extractDir}/server/server.py`)
    expect(resolved!.env?.TEST_VAR).toBe(`${os.homedir()}/data`)
    expect(resolved!.env?.PLATFORM_VAR).toBe('yes')
  })

  it('manifest 缺失或坏 JSON 返回 null（调用方降级并记 warn）', async () => {
    const missingDir = path.join(mcpDir, 'server-resolve-missing')
    expect(makeService().getResolvedMcpConfig(missingDir)).toBeNull()

    const brokenDir = path.join(mcpDir, 'server-resolve-broken')
    fs.mkdirSync(brokenDir, { recursive: true })
    fs.writeFileSync(path.join(brokenDir, 'manifest.json'), '{ not json')
    expect(makeService().getResolvedMcpConfig(brokenDir)).toBeNull()
  })
})

describe('cleanupDxtServerByPath', () => {
  it('删除 mcpDir 内的解包目录', async () => {
    const dir = path.join(mcpDir, 'server-cleanup-test')
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nested', 'file.txt'), 'x')

    expect(makeService().cleanupDxtServerByPath(dir)).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })

  // v1 二轮审查 m2-13：清理用途此前复用 ensurePathWithin 的「直系子目录」判据，二级子目录
  // 一律抛错并被 catch 吞成 false —— 配置已从注册表消失、解包目录永久留在磁盘上。
  it('删除 mcpDir 下的二级子目录（清理判据是「后代」而非「直系子目录」）', () => {
    const dir = path.join(mcpDir, 'group', 'server-nested-cleanup')
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nested', 'file.txt'), 'x')

    expect(makeService().cleanupDxtServerByPath(dir)).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('拒绝删除 mcpDir 之外的路径（误用防墙）', async () => {
    const outside = path.join(tempRoot, 'outside-dir')
    fs.mkdirSync(outside, { recursive: true })

    expect(makeService().cleanupDxtServerByPath(outside)).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('拒绝删除 mcpDir 的同名前缀兄弟目录（isPathInside 而非 startsWith）', () => {
    const sibling = `${mcpDir}-sibling`
    fs.mkdirSync(sibling, { recursive: true })

    expect(makeService().cleanupDxtServerByPath(sibling)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
    fs.rmSync(sibling, { recursive: true, force: true })
  })

  it('目录不存在返回 false', () => {
    expect(makeService().cleanupDxtServerByPath(path.join(mcpDir, 'server-never-was'))).toBe(false)
  })

  it('dxtServerDirExists 区分「本就不在」与「仍在」（调用方的可见信号判据）', () => {
    const dir = path.join(mcpDir, 'server-exists-probe')
    fs.mkdirSync(dir, { recursive: true })

    expect(makeService().dxtServerDirExists(dir)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
    expect(makeService().dxtServerDirExists(dir)).toBe(false)
    // mcpDir 之外的路径不参与存在性判定
    expect(makeService().dxtServerDirExists(path.join(tempRoot, 'outside-dir'))).toBe(false)
  })
})
