/**
 * 「重置数据」的清除范围。
 *
 * 背景：`Data/` 之外的三样（内核数据、provider key 真源、应用配置）原来不在重置范围内，
 * 于是"重置后 key/会话历史/应用配置全都还在"。本文件锁两件事：
 *   ① `resetData()` 是否把这三样也预备成"空副本"；
 *   ② `handleStartupRestore()` 下次启动时是否把它们顶掉真身。
 * 反证：把 `RESET_ROOT_ENTRIES` 里任一名字去掉，对应断言按名变红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fns } = vi.hoisted(() => ({
  fns: {
    pathExists: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
    writeJson: vi.fn(),
    rename: vi.fn(),
    copy: vi.fn(),
    readdir: vi.fn(),
    lstat: vi.fn(),
    stat: vi.fn(),
    realpath: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createWriteStream: vi.fn(),
    createReadStream: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => (key === 'userData' ? '/mock/userData' : '/mock/temp'))
  }
}))

vi.mock('fs-extra', () => ({ default: fns, ...fns }))

vi.mock('../../utils', () => ({
  getDataPath: vi.fn(() => '/mock/userData/Data')
}))

vi.mock('../WindowService', () => ({ windowService: { getMainWindow: vi.fn() } }))
vi.mock('../WebDav', () => ({ default: vi.fn() }))
vi.mock('../ProviderKeyStore', () => ({
  providerKeyStore: { getAll: vi.fn(() => ({})), setMany: vi.fn(), remove: vi.fn(), has: vi.fn() }
}))
vi.mock('archiver', () => ({ default: vi.fn() }))
vi.mock('node-stream-zip', () => ({ default: vi.fn() }))

import { BackupManager } from '../BackupManager'

const USER_DATA = '/mock/userData'
const ROOT_ENTRIES = ['kernel', 'provider-keys.json', 'config.json']

describe('「重置数据」的清除范围', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fns.pathExists.mockResolvedValue(false)
    fns.remove.mockResolvedValue(undefined)
    fns.ensureDir.mockResolvedValue(undefined)
    fns.writeJson.mockResolvedValue(undefined)
    fns.rename.mockResolvedValue(undefined)
  })

  it('resetData：Data/ 与根下三样（内核数据 / provider key / 应用配置）都预备成空副本', async () => {
    const manager = new BackupManager()
    await manager.resetData()

    const ensured = fns.ensureDir.mock.calls.map((call) => call[0])
    expect(ensured).toContain(`${USER_DATA}/Data.restore`)
    expect(ensured).toContain(`${USER_DATA}/kernel.restore`)

    const written = fns.writeJson.mock.calls.map((call) => call[0])
    expect(written).toContain(`${USER_DATA}/provider-keys.json.restore`)
    expect(written).toContain(`${USER_DATA}/config.json.restore`)
    // provider-keys 的 electron-store 形状必须是 { keys: {} }，写别的形状会让下次启动读不出（等于没重置）
    expect(fns.writeJson).toHaveBeenCalledWith(`${USER_DATA}/provider-keys.json.restore`, { keys: {} })
    expect(fns.writeJson).toHaveBeenCalledWith(`${USER_DATA}/config.json.restore`, {})
  })

  it('handleStartupRestore：用空副本顶掉真身，且真身是先挪开再删（不得先删后改名）', async () => {
    // 真身与 .restore 同时存在（真实还原场景）
    fns.pathExists.mockImplementation(async (target: string) =>
      ROOT_ENTRIES.some((name) => target === `${USER_DATA}/${name}.restore` || target === `${USER_DATA}/${name}`)
    )

    await BackupManager.handleStartupRestore()

    for (const name of ROOT_ENTRIES) {
      const dest = `${USER_DATA}/${name}`
      const staged = `${dest}.restore`
      // ① 旧真身被改名挪开（不是被 remove——先删后改名在改名失败时会双失）
      const asideCall = fns.rename.mock.calls.find(
        (call) => call[0] === dest && String(call[1]).startsWith(`${dest}.pre-restore-`)
      )
      expect(asideCall).toBeDefined()
      // ② 空副本顶到真身
      expect(fns.rename).toHaveBeenCalledWith(staged, dest)
      // ③ 只有挪开的那份被删；真身路径与 .restore 都不被删
      expect(fns.remove).not.toHaveBeenCalledWith(dest)
      expect(fns.remove).not.toHaveBeenCalledWith(staged)
      expect(fns.remove).toHaveBeenCalledWith(asideCall?.[1])
    }
  })

  it('还原失败时回滚旧真身并保留 .restore（失败不能清掉用户数据的唯一副本）', async () => {
    fns.pathExists.mockImplementation(async (target: string) =>
      ROOT_ENTRIES.some((name) => target === `${USER_DATA}/${name}.restore` || target === `${USER_DATA}/${name}`)
    )
    // staged → dest 的改名失败（Windows 上 sessions.db 被占的情形）
    fns.rename.mockImplementation(async (from: string) => {
      if (String(from).endsWith('.restore')) throw new Error('EBUSY')
    })

    await BackupManager.handleStartupRestore()

    for (const name of ROOT_ENTRIES) {
      expect(fns.remove).not.toHaveBeenCalledWith(`${USER_DATA}/${name}.restore`)
    }
    // 旧真身被改回原名（回滚），否则用户只剩一个 .pre-restore-* 目录
    const rollbacks = fns.rename.mock.calls.filter(
      (call) => String(call[0]).includes('.pre-restore-') && String(call[1]).startsWith(USER_DATA)
    )
    expect(rollbacks).toHaveLength(ROOT_ENTRIES.length)
  })

  it('没有任何 .restore 标记时直接返回，不碰用户数据', async () => {
    await BackupManager.handleStartupRestore()

    expect(fns.remove).not.toHaveBeenCalled()
    expect(fns.rename).not.toHaveBeenCalled()
  })
})
