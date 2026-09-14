import type { Dirent } from 'node:fs'
import { relative, sep } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 结构门禁：注入上下文"对 UI 不可见"必须靠结构，不靠各消费方自觉。
 *
 * v0.3.0 的教训是逐条封堵（四条路径全封了，仍漏掉历史搜索第五处）。本测试把
 * v0.3.0-1 的结构约束钉死成可执行断言：
 *   1. 渲染层只有 kernelEventStream 能触碰内核事件裸通道；
 *   2. 注入判据只在 sessionEventView 里定义（其余代码必须调用它，不得自己再写一遍）；
 *   3. 内核三个 UI 出口都施用同一判据（漏掉任一处即失败）。
 *
 * 注意：tests/main.setup.ts 全局 mock 了 node:fs（全部换成 vi.fn() 桩），本测试要读真实
 * 源码树，必须用 vi.importActual 取回真身；node:path 只为 join/resolve 打了桩，relative/sep
 * 仍是真身，可直接常规导入（不用 join，避免撞上桩）。
 */

/** 渲染层唯一允许触碰内核事件裸通道的文件。 */
const EVENT_STREAM_MODULE = 'src/renderer/src/services/kernelEventStream.ts'
/** 注入判据的唯一归属文件。 */
const VIEW_MODULE = 'src/main/kernel/sessionEventView.ts'
/** 内核三个 UI 出口。 */
const FORWARDING_MODULE = 'src/main/kernel/index.ts'
const SEARCH_MODULE = 'src/main/kernel/topics.ts'

const RAW_CHANNELS = ['window.api.dshTopicEvents', 'window.api.dshOnSessionEvent']
/** 判据写法（只认比较式，不认构造式 `kind: 'plugin'`——一次性 llm 调用要写这个字段）。 */
const INJECTION_PREDICATE = "kind === 'plugin'"

/** 本门禁在真实 node:fs 上用到的两个函数。 */
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

describe('UI 视界结构门禁', () => {
  it('渲染层只有 kernelEventStream.ts 触碰内核事件裸通道', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles('src/renderer/src')) {
      const repoPath = relativeToRepo(file)
      if (repoPath === EVENT_STREAM_MODULE) continue
      const source = readFileSyncActual(file, 'utf8')
      for (const needle of RAW_CHANNELS) {
        if (source.includes(needle)) offenders.push(`${repoPath} → ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('注入判据只在 sessionEventView.ts 里定义', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles('src/main')) {
      const repoPath = relativeToRepo(file)
      if (repoPath === VIEW_MODULE) continue
      if (repoPath.includes('__tests__')) continue
      if (readFileSyncActual(file, 'utf8').includes(INJECTION_PREDICATE)) offenders.push(repoPath)
    }
    expect(offenders).toEqual([])
  })

  it('内核三个 UI 出口都施用同一判据（广播 / 历史读取 / 全库搜索）', () => {
    const forwarding = readRepoFile(FORWARDING_MODULE)
    expect(forwarding).toContain('uiSessionEvent(event)')
    expect(forwarding).toContain('tree.uiEvents(id)')
    expect(readRepoFile(SEARCH_MODULE)).toContain('isInjectedUserEvent(event)')
  })
})
