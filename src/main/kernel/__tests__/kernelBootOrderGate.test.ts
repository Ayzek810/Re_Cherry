import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 结构门禁：**内核 IPC 的注册顺序**（v0.3.0-2 §6.9）。
 *
 * `src/main/index.ts` 建窗口与启动内核是**并行**的（`createMainWindow()` 之后才 `bootKernel()`），
 * 所以渲染层会在一段时间里问不到内核。此时两种"问不到"的后果完全不同：
 *
 * - `registerKernelIpc()` 在 `initTopics()` **之后**（现状）→ boot 窗口内**没有** `dsh:*` handler，
 *   `invoke` 以 "No handler registered" 拒绝 → 渲染层的对账判为"内核未知" → **不动任何行**（安全）；
 * - 若把顺序调换（先注册 handler 再 `initTopics`）→ `Dsh_TopicList` 会返回**空注册表** →
 *   对账会把"空"当成权威，**把全部历史行判为陈旧并剪除**（真事故：用户的行全没了，
 *   虽然会话还在、下次对账会补回来，但 `prompt`/`pinned` 这类渲染层私有字段会丢）。
 *
 * 因此这条顺序是**安全属性**，不是风格问题。
 */
const repoRoot = process.cwd()
const KERNEL_ENTRY = join(repoRoot, 'src', 'main', 'kernel', 'index.ts')

/** tests/main.setup.ts 全局 mock 了 node:fs，本门禁要读真实源码树，必须取回真身。 */
let readFileSyncActual: (file: string, encoding: 'utf8') => string

beforeAll(async () => {
  const actualFs = (await vi.importActual('node:fs')) as {
    readFileSync: (file: string, encoding: 'utf8') => string
  }
  readFileSyncActual = actualFs.readFileSync
})

describe('内核启动顺序门禁', () => {
  it('registerKernelIpc() 必须排在 initTopics() 之后（否则 boot 窗口会暴露空注册表）', () => {
    const source = readFileSyncActual(KERNEL_ENTRY, 'utf8')
    const initTopicsAt = source.indexOf('await initTopics(')
    const registerKernelIpcAt = source.indexOf('registerKernelIpc()')

    expect(initTopicsAt).toBeGreaterThan(-1)
    expect(registerKernelIpcAt).toBeGreaterThan(-1)
    expect(initTopicsAt).toBeLessThan(registerKernelIpcAt)
  })
})
