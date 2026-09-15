import type { Dirent } from 'node:fs'
import { relative, sep } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 结构门禁（v0.3.0-2 目标 A，`report.md` §2.4 的验A-1）：把"数据安全靠查库事实、不靠错误分类"
 * 钉成可执行断言，而不是靠后来者自觉。
 *
 * 背景：原实现在 `ensureAgent` 的 catch 里用 `instanceof` 判"日志读不出来"来决定是否拒绝新建。
 * 那条判据的鲁棒面不在本仓库（上游 dsh 对磁盘格式无兼容承诺），一旦抛错形态变化就**无声失效**
 * （fail-open）。现在判据是 `ctx.sessionPersistence.list()` 的存在性查询，错误分类降级为**日志
 * 富化**——本门禁守三条：①话题侧只有一条决议点；②决议点的判据是存在性查询；③分类器只被决议
 * 模块用于日志（既不进话题侧，也不成为第二个"允许新建"的门）。
 *
 * 注意：tests/main.setup.ts 全局 mock 了 node:fs（全部换成 vi.fn() 桩），本测试要读真实源码树，
 * 必须用 vi.importActual 取回真身；node:path 只为 join/resolve 打了桩，relative/sep 仍是真身。
 */

/** resume 兜底的唯一决议点。 */
const FALLBACK_MODULE = 'src/main/kernel/sessionResumeFallback.ts'
/** 诊断分类器的唯一归属文件。 */
const CLASSIFIER_MODULE = 'src/main/kernel/sessionReadFailure.ts'
/** 决议点的调用方（话题注册表 / 发送路径）。 */
const TOPICS_MODULE = 'src/main/kernel/topics.ts'

type ReaddirSync = (dir: string, options: { withFileTypes: true }) => Dirent[]
type ReadFileSync = (file: string, encoding: 'utf8') => string

let readdirSyncActual: ReaddirSync
let readFileSyncActual: ReadFileSync
let repoRoot: string

beforeAll(async () => {
  const actualFs = (await vi.importActual('node:fs')) as {
    readdirSync: ReaddirSync
    readFileSync: ReadFileSync
  }
  readdirSyncActual = actualFs.readdirSync
  readFileSyncActual = actualFs.readFileSync
  repoRoot = process.cwd()
})

function listSourceFiles(relativeDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSyncActual(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在（如被清理）视为空
    }
    for (const entry of entries) {
      const full = dir + sep + entry.name
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) found.push(full)
    }
  }
  walk(repoRoot + sep + relativeDir)
  return found
}

function relativeToRepo(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/')
}

function readRepoFile(relativePath: string): string {
  return readFileSyncActual(repoRoot + sep + relativePath, 'utf8')
}

describe('resume 兜底结构门禁', () => {
  it('话题侧只有一条决议点，且不再自己用错误分类放行', () => {
    const topics = readRepoFile(TOPICS_MODULE)
    expect(topics).toContain('resumeOrCreateSession(')
    // 分类器（以及它曾经的布尔版）不得出现在话题侧：安全判据一旦回到"判错误类型"即失败
    expect(topics).not.toContain('sessionReadFailure')
    expect(topics).not.toContain('isUnreadableSessionError')
  })

  it('决议模块的判据是持久化存在性查询，且新建点唯一、位于判定之后', () => {
    const source = readRepoFile(FALLBACK_MODULE)
    expect(source).toContain('await listPersisted()')
    expect(source).toContain('header.id === sessionId')
    // 新建调用点唯一：决定与执行同处一点，调用方拿不到"先建后判"的余地
    expect(source.match(/createFresh\(\)/g)).toHaveLength(1)
    // 决定先于分类：分类只用于日志，不参与是否新建
    expect(source.indexOf('header.id === sessionId')).toBeLessThan(source.indexOf('classifySessionReadFailure('))
  })

  it('诊断分类器只被决议模块引用（既非死代码，也不是第二个门）', () => {
    const users: string[] = []
    for (const file of listSourceFiles('src/main')) {
      const repoPath = relativeToRepo(file)
      if (repoPath === CLASSIFIER_MODULE || repoPath.includes('__tests__')) continue
      if (readFileSyncActual(file, 'utf8').includes('classifySessionReadFailure')) users.push(repoPath)
    }
    expect(users).toEqual([FALLBACK_MODULE])
  })
})
