import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// 切断 topics.ts → SearchService/webFetch 的传递图（electron CJS 具名导入在
// vitest 下收集期即炸——registryCorruptionGuard.test 同款处理）。
vi.mock('@main/services/SearchService', () => ({ searchService: {} }))
vi.mock('@main/services/webSearchProviders/webFetch', () => ({ fetchWebContent: vi.fn(async () => ({ content: '' })) }))

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'registry-race-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

/**
 * v0.4 真机实证回归：渲染层多选删除并发触发 persistRegistry，固定 tmp 名下
 * 写-改名交错产生连环 ENOENT。修复 = 串行闸 + 唯一 tmp 名。
 * （os.tmpdir 被 main.setup mock 掉，用系统 TEMP 环境变量作临时根——存量同款。）
 */
describe('persistRegistry 并发安全', () => {
  it('40 concurrent persists all succeed and leave exactly one valid topics.json', async () => {
    const { loadRegistry, persistRegistry } = await import('../topics')
    const dir = await makeTempDir()
    await loadRegistry(dir)

    // 与真机事故同形态：注册表内容逐次变化（模拟删除进行中），全部并发发起。
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (async () => {
          // 各调用间微差内容（模拟内存注册表在删除推进中）。
          await new Promise((resolve) => setTimeout(resolve, i % 7))
          await persistRegistry()
        })()
      )
    )

    const file = path.join(dir, 'kernel', 'topics.json')
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as { topics: unknown[] }
    expect(Array.isArray(parsed.topics)).toBe(true)
    // 唯一 tmp 名：目录里不允许残留 .tmp（全部已 rename 落位）。
    const leftovers = (await readdir(path.join(dir, 'kernel'))).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})
