import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { memoryAppend, memorySearch, memoryUpdate } from '../memoryTool'

/** 主测试 setup mock 掉 node:os（无 tmpdir），临时目录挂进程工作目录下统一清扫。 */
const TEMP_BASE = join(process.cwd(), '.tmp-kernel-memory-tests')

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true })
})
afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true })
})

/**
 * memory 工具机测（v0.4.6 V2 memoryTools 同构）：FACT.md 原子覆写、JOURNAL.jsonl
 * 追加/查询（真实文件系统，不用 mock 文件层）。
 */
describe('memoryUpdate', () => {
  it('覆写 FACT.md（原子落盘）', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await memoryUpdate(dir, '# Facts\n\n- project: Re_Cherry')
    expect(await readFile(join(dir, 'FACT.md'), 'utf-8')).toBe('# Facts\n\n- project: Re_Cherry')
    await rm(dir, { recursive: true, force: true })
  })

  it('重复覆写为整体替换', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await memoryUpdate(dir, 'v1')
    await memoryUpdate(dir, 'v2')
    expect(await readFile(join(dir, 'FACT.md'), 'utf-8')).toBe('v2')
    await rm(dir, { recursive: true, force: true })
  })

  it('空内容具名拒绝且不落盘', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await expect(memoryUpdate(dir, '   ')).rejects.toThrow(/'content' is required/)
    const entries = await readdir(dir)
    expect(entries).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })

  it('失败清理临时文件（不残留 .tmp）', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    // 预置同名目录让 rename 失败（目录项冲突）。
    await mkdir(join(dir, 'FACT.md'))
    await expect(memoryUpdate(dir, 'content')).rejects.toThrow()
    const entries = await readdir(dir)
    expect(entries.filter((entry) => entry.includes('.tmp'))).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('memoryAppend', () => {
  it('追加一行 JSON（ts/tags/text）', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    const ts = await memoryAppend(dir, '完成 A 任务', ['work'])
    const raw = await readFile(join(dir, 'JOURNAL.jsonl'), 'utf-8')
    const entry = JSON.parse(raw.trim())
    expect(entry).toMatchObject({ text: '完成 A 任务', tags: ['work'] })
    expect(entry.ts).toBe(ts)
    await rm(dir, { recursive: true, force: true })
  })

  it('连续追加按序成行', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await memoryAppend(dir, 'one', [])
    await memoryAppend(dir, 'two', ['tag'])
    const raw = await readFile(join(dir, 'JOURNAL.jsonl'), 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).text).toBe('two')
    await rm(dir, { recursive: true, force: true })
  })

  it('空 text 具名拒绝', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await expect(memoryAppend(dir, '', [])).rejects.toThrow(/'text' is required/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('memorySearch', () => {
  it('查询：大小写不敏感子串 + 最新优先 + limit', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await memoryAppend(dir, 'Alpha event', ['a'])
    await memoryAppend(dir, 'beta event', ['b'])
    await memoryAppend(dir, 'Gamma EVENT', ['a'])
    const hits = await memorySearch(dir, 'event', '', 20)
    expect(hits).toHaveLength(3)
    expect(hits[0].text).toBe('Gamma EVENT')
    expect((await memorySearch(dir, 'alpha', '', 20)).map((entry) => entry.text)).toEqual(['Alpha event'])
    expect(await memorySearch(dir, 'nomatch', '', 20)).toEqual([])
    expect((await memorySearch(dir, '', 'b', 20)).map((entry) => entry.text)).toEqual(['beta event'])
    expect((await memorySearch(dir, '', 'B', 20)).map((entry) => entry.text)).toEqual(['beta event'])
    const limited = await memorySearch(dir, '', '', 1)
    expect(limited).toHaveLength(1)
    expect(limited[0].text).toBe('Gamma EVENT')
    await rm(dir, { recursive: true, force: true })
  })

  it('无 journal 文件返回空（ENOENT 非错误）', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    expect(await memorySearch(dir, 'anything', '', 20)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  it('损坏行跳过不炸查询', async () => {
    const dir = await mkdtemp(join(TEMP_BASE, 'memory-'))
    await memoryAppend(dir, 'good entry', [])
    await writeFile(join(dir, 'JOURNAL.jsonl'), '{corrupted}\n', { flag: 'a' })
    const hits = await memorySearch(dir, 'good', '', 20)
    expect(hits).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })
})
