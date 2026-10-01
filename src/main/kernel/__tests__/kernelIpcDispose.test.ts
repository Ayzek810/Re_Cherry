import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * k2-29 结构钉板：内核 IPC handler 必须与 `stopKernel()` 配对撤销。
 *
 * 缺陷原状：`registerKernelIpc()` 注册约 30 个 `dsh:*` handler，`stopKernel()` 只拆 fiber
 * （`ipcMain.removeHandler` 全仓只有 `LoggerService` 清理自己那一条）。后果不是"脏 handler"
 *（撤销后 `requireKernel()` 仍以 `kernel not booted` 拒绝），而是**二次 `bootKernel()`**
 *（模块重载 / 测试宿主）会撞 Electron 的 "Attempted to register a second handler"，
 * 且只在运行期抛。`registerInteractionHost` 丢弃的 `registerProvider` 注销函数同型。
 *
 * 本文件不真的 boot 内核（需要整套 dsh 插件与真实 SQLite），而是把三条**结构契约**钉在源码上：
 * 1. handler 的注册面全部经 `handle(...)` 包装（漏一处就有通道逃出撤销清单）；
 * 2. `registerKernelIpc` 返回的注销函数逐 channel 调 `ipcMain.removeHandler`；
 * 3. `stopKernel()` 调用了这个注销函数与问答 provider 的注销函数。
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

function kernelSource(): string {
  return readFileSyncActual(KERNEL_ENTRY, 'utf8')
}

/** `registerKernelIpc` 的函数体（从签名到文件里下一个顶层 `function ` 之前）。 */
function registerKernelIpcBody(source: string): string {
  const start = source.indexOf('function registerKernelIpc(')
  expect(start).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const nextTopLevel = rest.indexOf('\nfunction ', 1)
  return nextTopLevel === -1 ? rest : rest.slice(0, nextTopLevel)
}

describe('内核 IPC handler 与停机配对（k2-29）', () => {
  it('handler 注册面全部经 handle(...) 记账，没有裸 ipcMain.handle', () => {
    const body = registerKernelIpcBody(kernelSource())
    // 唯一的 `ipcMain.handle(` 出现在包装器里——任何直连调用都会在这里多出一条。
    const handleCalls = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('ipcMain.handle('))
    expect(handleCalls).toEqual(['ipcMain.handle(channel, listener)'])
    expect((body.match(/ipcMain\.handle\(/g) ?? []).length).toBe(1)
    // 29 = 24 处 `handle(IpcChannel.X` 单行 + 5 处 `handle(` 换行写法。总数变化意味着
    // 有人加了/删了内核通道：那是三层契约的事，必须显式过一遍本测试。
    const wrapped = (body.match(/handle\(IpcChannel\./g) ?? []).length + (body.match(/\n\s+handle\($/gm) ?? []).length
    expect(wrapped).toBe(29)
  })

  it('注销函数逐 channel 调用 ipcMain.removeHandler', () => {
    const body = registerKernelIpcBody(kernelSource())
    expect(body).toContain('return () => {')
    expect(body).toMatch(/for \(const channel of registeredChannels\)/)
    expect(body).toContain('ipcMain.removeHandler(channel)')
  })

  it('stopKernel() 调用注销函数与问答 provider 注销函数', () => {
    const source = kernelSource()
    const stopStart = source.indexOf('export async function stopKernel(')
    expect(stopStart).toBeGreaterThan(-1)
    const stopBody = source.slice(stopStart, source.indexOf('\n}\n', stopStart))
    expect(stopBody).toContain('kernelIpcDispose?.()')
    expect(stopBody).toContain('interactionUnregister?.()')
    // 幂等：两个引用都必须清空，避免第二次 stopKernel 重复撤销。
    expect(stopBody).toContain('kernelIpcDispose = undefined')
    expect(stopBody).toContain('interactionUnregister = undefined')
    // boot 侧确实把两个撤销函数存了下来（否则 stop 里那两个调用永远是 no-op）。
    expect(source).toContain('kernelIpcDispose = registerKernelIpc()')
    expect(source).toContain('interactionUnregister = interaction.unregister')
  })
})
