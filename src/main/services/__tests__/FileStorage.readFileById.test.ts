import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// tests/main.setup.ts 全局把 node:fs / node:path / node:os 换成桩。本被测方法的核心判据就是
// "文件到底在不在"以及路径归属，用桩来喂答案会变成自证，故按文件恢复真实模块
// （BackupManager.test.ts / ObsidianVaultService.test.ts 的重 mock 先例；工厂被提升，逻辑内联）。
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

import { fileStorage } from '../FileStorage'

let storageDir: string

const call = (id: string) => fileStorage.readFileById({} as never, id)

beforeEach(() => {
  // .tmp- 前缀 fixture（仓规约定），afterEach 整树删除
  storageDir = mkdtempSync(join(tmpdir(), '.tmp-file-readbyid-'))
  // 私有字段指向本测试的临时目录：被测行为是"按 id 在存储目录里找文件"，与用户数据无关。
  ;(fileStorage as unknown as { storageDir: string }).storageDir = storageDir
})

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true })
})

describe('FileStorage.readFileById（不存在 vs 读不出来）', () => {
  it('文件不存在 → status:missing（确定的终局答案，不是 error）', async () => {
    await expect(call('custom-minapps.json')).resolves.toEqual({ status: 'missing' })
  })

  it('文件存在且可读 → status:ok + 内容', async () => {
    writeFileSync(join(storageDir, 'custom-minapps.json'), '[{"id":"mine"}]', 'utf8')

    await expect(call('custom-minapps.json')).resolves.toEqual({
      status: 'ok',
      content: '[{"id":"mine"}]'
    })
  })

  it('路径存在但读不出来（这里是目录）→ status:error，**不得**降级成 missing', async () => {
    mkdirSync(join(storageDir, 'not-a-file.json'))

    const result = await call('not-a-file.json')

    expect(result.status).toBe('error')
    expect(result.status).not.toBe('missing')
  })

  it('输入校验：空 id / 含空字节的 id 直接拒绝（不进入文件系统解析）', async () => {
    await expect(call('')).rejects.toThrow('non-empty string')
    await expect(call('a\0b')).rejects.toThrow('null byte')
  })

  it('输入校验：越过存储目录的 id 被拒绝（不读仓外文件）', async () => {
    await expect(call('../outside.json')).rejects.toThrow('storage directory')
  })
})
