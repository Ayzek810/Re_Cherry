import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// tests/main.setup.ts 全局 mock 了 node:fs / node:path（连同无前缀形式）与 node:os——
// 本被测服务是纯 fs 实现，这里按文件恢复真实模块（BackupManager.test.ts 重mock先例）。
// 注意 vi.mock 工厂会被提升：逻辑必须内联，不能引用本文件的顶层变量。
vi.mock('node:fs', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, default: actual.default ?? actual }
})
vi.mock('fs', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, default: actual.default ?? actual }
})
vi.mock('node:path', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, default: actual.default ?? actual }
})
vi.mock('path', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, default: actual.default ?? actual }
})
vi.mock('node:os', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, default: actual.default ?? actual }
})

import ObsidianVaultService from '../ObsidianVaultService'

let tempRoot: string

const createVault = (name: string): string => {
  const vaultPath = join(tempRoot, name)
  mkdirSync(vaultPath, { recursive: true })
  return vaultPath
}

const writeObsidianConfig = (vaults: Record<string, { path: string; name?: string }>): string => {
  const configPath = join(tempRoot, 'obsidian.json')
  writeFileSync(configPath, JSON.stringify({ vaults }), 'utf8')
  return configPath
}

beforeEach(() => {
  // .tmp- 前缀 fixture（仓规约定），afterEach 整树删除
  tempRoot = mkdtempSync(join(tmpdir(), '.tmp-obsidian-vault-'))
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('ObsidianVaultService.getVaults', () => {
  it('enumerates vaults from obsidian.json', () => {
    const vaultPath = createVault('MyVault')
    const configPath = writeObsidianConfig({ id1: { path: vaultPath, name: 'MyVault' } })

    const service = new ObsidianVaultService(configPath)
    expect(service.getVaults()).toEqual([{ path: vaultPath, name: 'MyVault' }])
  })

  it('falls back to basename when vault has no name', () => {
    const vaultPath = createVault('UnnamedVault')
    const configPath = writeObsidianConfig({ id1: { path: vaultPath } })

    const service = new ObsidianVaultService(configPath)
    expect(service.getVaults()).toEqual([{ path: vaultPath, name: 'UnnamedVault' }])
  })

  it('returns empty when config file does not exist', () => {
    const service = new ObsidianVaultService(join(tempRoot, 'missing', 'obsidian.json'))
    expect(service.getVaults()).toEqual([])
  })

  it('returns empty on malformed config JSON instead of throwing', () => {
    const configPath = join(tempRoot, 'obsidian.json')
    writeFileSync(configPath, '{ not-json', 'utf8')

    const service = new ObsidianVaultService(configPath)
    expect(service.getVaults()).toEqual([])
  })

  it('returns empty when config has no vaults field', () => {
    const configPath = join(tempRoot, 'obsidian.json')
    writeFileSync(configPath, JSON.stringify({ something: 'else' }), 'utf8')

    const service = new ObsidianVaultService(configPath)
    expect(service.getVaults()).toEqual([])
  })
})

describe('ObsidianVaultService.getVaultStructure', () => {
  it('collects nested folders and markdown files with forward-slash relative paths', () => {
    const vaultPath = createVault('TreeVault')
    const sub = join(vaultPath, 'Projects', 'Deep')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(vaultPath, 'root.md'), '# root', 'utf8')
    writeFileSync(join(sub, 'note.md'), '# note', 'utf8')
    writeFileSync(join(vaultPath, 'ignored.txt'), 'not markdown', 'utf8')

    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    const result = service.getVaultStructure(vaultPath)

    const paths = result.map((f) => f.path)
    expect(paths).toContain('Projects')
    expect(paths).toContain('Projects/Deep')
    expect(paths).toContain('root.md')
    expect(paths).toContain('Projects/Deep/note.md')
    expect(paths).not.toContain('ignored.txt')

    const folders = result.filter((f) => f.type === 'folder')
    expect(folders.map((f) => f.name)).toEqual(expect.arrayContaining(['Projects', 'Deep']))

    const markdowns = result.filter((f) => f.type === 'markdown')
    expect(markdowns.map((f) => f.name)).toEqual(expect.arrayContaining(['root.md', 'note.md']))
  })

  it('ignores dot-directories (e.g. .obsidian) and their contents', () => {
    const vaultPath = createVault('HiddenVault')
    const hidden = join(vaultPath, '.obsidian')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(hidden, 'workspace.md'), 'should be ignored', 'utf8')
    writeFileSync(join(vaultPath, 'visible.md'), 'visible', 'utf8')

    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    const result = service.getVaultStructure(vaultPath)

    expect(result.map((f) => f.path)).toEqual(['visible.md'])
  })

  it('ignores dot-files at any level', () => {
    const vaultPath = createVault('DotFileVault')
    writeFileSync(join(vaultPath, 'keep.md'), 'keep', 'utf8')
    writeFileSync(join(vaultPath, '.hidden.md'), 'hidden', 'utf8')

    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    const result = service.getVaultStructure(vaultPath)

    expect(result.map((f) => f.path)).toEqual(['keep.md'])
  })

  it('returns empty for a nonexistent vault path', () => {
    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    expect(service.getVaultStructure(join(tempRoot, 'nope'))).toEqual([])
  })

  it('returns empty when the path is a file, not a directory', () => {
    const filePath = join(tempRoot, 'a-file.md')
    writeFileSync(filePath, 'x', 'utf8')

    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    expect(service.getVaultStructure(filePath)).toEqual([])
  })

  it('returns empty for an empty vault', () => {
    const vaultPath = createVault('EmptyVault')

    const service = new ObsidianVaultService(join(tempRoot, 'obsidian.json'))
    expect(service.getVaultStructure(vaultPath)).toEqual([])
  })
})

describe('ObsidianVaultService.getFilesByVaultName', () => {
  it('resolves the vault by name and returns its structure', () => {
    const vaultPath = createVault('ByNameVault')
    writeFileSync(join(vaultPath, 'doc.md'), '# doc', 'utf8')
    const configPath = writeObsidianConfig({ id1: { path: vaultPath, name: 'ByNameVault' } })

    const service = new ObsidianVaultService(configPath)
    const result = service.getFilesByVaultName('ByNameVault')

    expect(result.map((f) => f.path)).toEqual(['doc.md'])
  })

  it('returns empty for an unknown vault name', () => {
    const vaultPath = createVault('KnownVault')
    const configPath = writeObsidianConfig({ id1: { path: vaultPath, name: 'KnownVault' } })

    const service = new ObsidianVaultService(configPath)
    expect(service.getFilesByVaultName('NoSuchVault')).toEqual([])
  })
})
