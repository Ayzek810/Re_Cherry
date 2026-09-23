/**
 * provider key 的跨目录补齐（v0.3.3-1 修复"更新后 key 消失要重填"）。
 *
 * 真机事故链（详见 `docs/v0.3.3-1_doc.md` §5）：electron-store 在**构造时**取
 * `app.getPath('userData')`，而 `ProviderKeyStore` 单例在打包产物里被入口最先 require ⇒ 构造早于
 * `initAppDataDir()` 的重定向 ⇒ key 文件落在 Electron 默认目录，与应用其余数据分居两地；构建的
 * chunk 切分一变就读到另一个文件，用户此前填的 key"消失"。
 *
 * 本测试钉住处置链里**可纯函数化**的部分：vault 内容解析、非破坏性合并（新增 + 更新者赢）、候选路径口径。
 * （懒构造时机与 Electron 真路径解析无法在此环境单测，靠代码结构 + 真机验证。）
 */
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => (name === 'appData' ? 'C:/Users/tester/AppData/Roaming' : 'C:/tmp')),
  getName: vi.fn(() => 'Re_Cherry')
}))

vi.mock('electron', () => ({
  app: appMock,
  safeStorage: { encryptString: vi.fn(), decryptString: vi.fn() }
}))
vi.mock('electron-store', () => ({ default: class {} }))

import { candidateVaultPaths, mergeVaults, parseVaultKeys, vaultPathsFromConfig } from '../ProviderKeyStore'

describe('parseVaultKeys', () => {
  it('读 { keys: {...} } 形状并过滤空值', () => {
    expect(parseVaultKeys(JSON.stringify({ keys: { silicon: 'cipher-a', empty: '', deepseek: 'cipher-b' } }))).toEqual(
      { silicon: 'cipher-a', deepseek: 'cipher-b' }
    )
  })

  it('坏 JSON、坏形状、空文件都退化成空表（不抛）', () => {
    expect(parseVaultKeys('{ not json')).toEqual({})
    expect(parseVaultKeys('{}')).toEqual({})
    expect(parseVaultKeys(JSON.stringify({ keys: null }))).toEqual({})
    expect(parseVaultKeys(JSON.stringify({ keys: { a: 42 } }))).toEqual({})
  })
})

describe('mergeVaults', () => {
  const ours = { path: 'F:/Documents/Re_Cherry/provider-keys.json', keys: { silicon: 'mine', scnet: '' }, mtimeMs: 100 }

  it('本表缺的补进来、不删除任何条目', () => {
    const { keys, added, updated } = mergeVaults(ours, [
      { path: 'C:/other/provider-keys.json', keys: { deepseek: 'their-cipher', scnet: 'their-cipher' }, mtimeMs: 50 }
    ])

    expect(keys).toEqual({ silicon: 'mine', scnet: 'their-cipher', deepseek: 'their-cipher' })
    expect(added.sort()).toEqual(['deepseek', 'scnet'])
    expect(updated).toEqual([])
  })

  it('两边都有且候选文件更新：新的赢（用户重填过的 key 不能被旧密文盖掉）', () => {
    const { keys, updated } = mergeVaults(ours, [
      { path: 'C:/other/provider-keys.json', keys: { silicon: 'reentered' }, mtimeMs: 200 }
    ])

    expect(keys.silicon).toBe('reentered')
    expect(updated).toEqual(['silicon'])
  })

  it('候选文件更旧：绝不覆盖本表已有密文', () => {
    const { keys, updated } = mergeVaults(ours, [
      { path: 'C:/old/provider-keys.json', keys: { silicon: 'stale' }, mtimeMs: 10 }
    ])

    expect(keys.silicon).toBe('mine')
    expect(updated).toEqual([])
  })

  it('多份候选按 mtime 升序应用，故新的那份赢；空值/读不到的文件不参与', () => {
    const { keys, added, updated } = mergeVaults(ours, [
      { path: 'C:/new/provider-keys.json', keys: { deepseek: 'newer', silicon: 'newer' }, mtimeMs: 300 },
      { path: 'C:/mid/provider-keys.json', keys: { deepseek: 'older' }, mtimeMs: 150 },
      { path: 'C:/missing/provider-keys.json', keys: {}, mtimeMs: -1 }
    ])

    expect(keys.deepseek).toBe('newer')
    expect(keys.silicon).toBe('newer')
    expect(added).toEqual(['deepseek'])
    expect(updated).toEqual(['silicon'])
  })

  it('无任何新增/更新时返回空信号（调用方据此跳过写盘）', () => {
    const { keys, added, updated } = mergeVaults({ path: 'p', keys: { a: 'cipher' }, mtimeMs: 500 }, [
      { path: 'C:/old/provider-keys.json', keys: { a: 'other', b: '' }, mtimeMs: 1 }
    ])

    expect(keys).toEqual({ a: 'cipher' })
    expect(added).toEqual([])
    expect(updated).toEqual([])
  })
})

describe('vaultPathsFromConfig', () => {
  const current = path.join('F:', 'Documents', 'Re_Cherry', 'provider-keys.json')

  it('取出登记过的 dataPath（数组形态），并排除当前路径本身', () => {
    const raw = JSON.stringify({
      appDataPath: [
        { executablePath: 'F:/Re_Cherry/Re_Cherry.exe', dataPath: path.join('F:', 'Documents', 'Re_Cherry') },
        { executablePath: 'C:/Other/Re_Cherry.exe', dataPath: path.join('C:', 'Other', 'Data') }
      ]
    })

    const paths = vaultPathsFromConfig(raw, current)

    expect(paths).toEqual([path.join('C:', 'Other', 'Data', 'provider-keys.json')])
  })

  it('兼容旧版字符串形态；空表/坏 JSON → 空数组', () => {
    expect(vaultPathsFromConfig(JSON.stringify({ appDataPath: path.join('D:', 'Legacy') }), current)).toEqual([
      path.join('D:', 'Legacy', 'provider-keys.json')
    ])
    expect(vaultPathsFromConfig('{}', current)).toEqual([])
    expect(vaultPathsFromConfig('not json', current)).toEqual([])
  })
})

describe('candidateVaultPaths', () => {
  it('包含 Electron 默认目录那一份，且排除当前路径本身', () => {
    const current = path.join('F:', 'Documents', 'Re_Cherry', 'provider-keys.json')
    const candidates = candidateVaultPaths(current)

    expect(candidates).toContain(
      path.join(appMock.getPath('appData'), appMock.getName(), 'provider-keys.json')
    )
    expect(candidates).not.toContain(current)
  })
})
