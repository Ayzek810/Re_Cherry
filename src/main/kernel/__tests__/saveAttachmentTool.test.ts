import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 切断 saveAttachmentTool → knowledgeService → SearchService → electron 的传递图
//（electron CJS 具名导入在 vitest 环境炸，registryPersistRace.test 同惯例）。
vi.mock('@main/services/knowledge/KnowledgeService', () => ({
  knowledgeService: {
    getTurnDocuments: vi.fn(() => undefined)
  }
}))

import { copyNoClobber, hasWindowsInvalidFilenameSegment, validateOutputPath } from '../saveAttachmentTool'

/**
 * save_attachment 纯函数机测（V2 移植）：输出路径校验（工作区相对/禁 .. 禁非法
 * 字符）与 wx 独占复制（EEXIST 具名、失败回滚）。真实 fs（fs/promises 未被 setup mock）。
 * 主测试 setup mock 掉 node:os，临时目录挂进程工作目录下统一清扫。
 */
const TEMP_BASE = join(process.cwd(), '.tmp-kernel-save-att-tests')

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true })
})
afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true })
})

describe('validateOutputPath', () => {
  it('工作区相对路径放行（正斜杠归一）', () => {
    expect(validateOutputPath('out/report.md')).toBe('out/report.md')
    expect(validateOutputPath('out\\report.md')).toBe('out/report.md')
  })

  it('拒绝绝对路径（posix / 盘符 / 反斜杠根）', () => {
    expect(() => validateOutputPath('/etc/passwd')).toThrow(/workspace-relative/)
    expect(() => validateOutputPath('C:\\temp\\x.txt')).toThrow(/workspace-relative/)
    expect(() => validateOutputPath('\\share\\x.txt')).toThrow(/workspace-relative/)
  })

  it('拒绝 .. 穿越', () => {
    expect(() => validateOutputPath('../secret.txt')).toThrow(/traverse/)
    expect(() => validateOutputPath('a/../../secret.txt')).toThrow(/traverse/)
  })

  it('拒绝 Windows 非法字符段', () => {
    expect(() => validateOutputPath('bad<name>.txt')).toThrow(/invalid in Windows/)
    expect(() => validateOutputPath('bad:name.txt')).toThrow(/invalid in Windows/)
  })

  it('拒绝空值与非字符串', () => {
    expect(() => validateOutputPath('')).toThrow(/1\.\.4096/)
    expect(() => validateOutputPath(undefined)).toThrow(/must be a string/)
    expect(() => validateOutputPath(123)).toThrow(/must be a string/)
  })
})

describe('hasWindowsInvalidFilenameSegment', () => {
  it('非法字符集与控制字符', () => {
    expect(hasWindowsInvalidFilenameSegment('a<b.txt')).toBe(true)
    expect(hasWindowsInvalidFilenameSegment('a\u0001b.txt')).toBe(true)
    expect(hasWindowsInvalidFilenameSegment('正常-名称_v2.txt')).toBe(false)
  })
})

describe('copyNoClobber', () => {
  it('目标已存在具名报错（不覆盖）', async () => {
    const dir = await mkdtemp(TEMP_BASE + '-')
    const dest = join(dir, 'out.bin')
    await writeFile(dest, 'existing')
    await writeFile(join(dir, 'src.bin'), 'new')
    await expect(copyNoClobber(join(dir, 'src.bin'), dest)).rejects.toThrow(/already exists/)
    expect(await readFile(dest, 'utf-8')).toBe('existing')
    await rm(dir, { recursive: true, force: true })
  })

  it('复制成功且字节一致（二进制含换行序列）', async () => {
    const dir = await mkdtemp(TEMP_BASE + '-')
    const src = join(dir, 'src.bin')
    const payload = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10])
    await writeFile(src, payload)
    const dest = join(dir, 'out.bin')
    await copyNoClobber(src, dest)
    expect(await readFile(dest)).toEqual(payload)
    await rm(dir, { recursive: true, force: true })
  })

  it('源不存在时失败且不留半成品', async () => {
    const dir = await mkdtemp(TEMP_BASE + '-')
    const dest = join(dir, 'out.bin')
    await expect(copyNoClobber(join(dir, 'missing.bin'), dest)).rejects.toThrow()
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(dir, { recursive: true, force: true })
  })

  it('abort 信号中止并回滚半成品', async () => {
    const dir = await mkdtemp(TEMP_BASE + '-')
    const src = join(dir, 'src.bin')
    await writeFile(src, 'x'.repeat(1000))
    const dest = join(dir, 'out.bin')
    const controller = new AbortController()
    controller.abort()
    await expect(copyNoClobber(src, dest, controller.signal)).rejects.toThrow()
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(dir, { recursive: true, force: true })
  })
})
