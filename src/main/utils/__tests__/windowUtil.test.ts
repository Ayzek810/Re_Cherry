import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 稳定性说明（v0.3.0-1 后续修复存量 flaky）：
 *
 * 本文件原先通过 `vi.doMock('../../constant', () => ({ isWin }))` 来控制 isWin，而
 * `isWin` 的真值来源是 `src/main/constant.ts` 的 `process.platform === 'win32'`。
 * 在全量测试（多文件共用 worker 进程）里，模块 mock 的时序会让**真实的 Windows 平台值**
 * 漏进来——表现为 `returns undefined on non-Windows platforms` 偶发失败（实得 'mica'，
 * 即 isWin 被判为 true）。
 *
 * 修法：不再 mock 模块，改为桩住 `process.platform` 与 `process.getSystemVersion`
 * 这两个**真值来源**，再 `vi.resetModules()` 让 constant.ts 重新求值。afterEach 精确还原。
 */
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalGetSystemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion')

async function loadWindowUtil({ isWin, systemVersion = '' }: { isWin: boolean; systemVersion?: string }) {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { value: isWin ? 'win32' : 'darwin', configurable: true })
  Object.defineProperty(process, 'getSystemVersion', { value: () => systemVersion, configurable: true })

  const windowUtil = await import('../windowUtil')
  return { ...windowUtil }
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  if (originalGetSystemVersion) Object.defineProperty(process, 'getSystemVersion', originalGetSystemVersion)
})

describe('getWindowsBackgroundMaterial', () => {
  it('returns mica on Windows 11 22H2 and newer', async () => {
    const { getWindowsBackgroundMaterial } = await loadWindowUtil({
      isWin: true,
      systemVersion: '10.0.22621'
    })

    expect(getWindowsBackgroundMaterial()).toBe('mica')
  })

  it('returns undefined below the Windows 11 22H2 build threshold', async () => {
    const { getWindowsBackgroundMaterial } = await loadWindowUtil({
      isWin: true,
      systemVersion: '10.0.22000'
    })

    expect(getWindowsBackgroundMaterial()).toBeUndefined()
  })

  it('returns undefined when the system version cannot be parsed', async () => {
    const { getWindowsBackgroundMaterial } = await loadWindowUtil({
      isWin: true,
      systemVersion: 'Windows 11'
    })

    expect(getWindowsBackgroundMaterial()).toBeUndefined()
  })

  it('returns undefined on non-Windows platforms', async () => {
    const { getWindowsBackgroundMaterial } = await loadWindowUtil({
      isWin: false,
      systemVersion: '10.0.22621'
    })

    expect(getWindowsBackgroundMaterial()).toBeUndefined()
  })
})
