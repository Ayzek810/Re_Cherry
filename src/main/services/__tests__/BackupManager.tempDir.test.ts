/**
 * v1 二轮审查 m2-11 的行为证据：备份/还原的暂存目录按调用独占。
 *
 * 此前 `tempDir` 是实例字段，`backup()` 结尾 `fs.remove(this.tempDir)`、`restore()` 开头
 * `ensureDir(this.tempDir)` 共用同一目录，主进程侧没有互斥。两个入口（设置页备份/还原、
 * WebDAV 定时备份）在一次长拷贝未结束时触发另一次，第二次的 `ensureDir`/`remove` 会把第一次
 * 正在拷贝的中间目录删掉或混进自己的归档——静默产出坏 zip。
 *
 * 本文件用真 fs（setup 层把 node:fs/node:path/node:os 换成浅 mock，这里恢复真实现）走完整
 * `backup()`，断言每次调用的暂存根互不相同、且各自只清自己的目录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})
vi.mock('node:path', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})

const { mockLogger, paths } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  paths: { tempRoot: '' }
}))

vi.mock('@logger', () => ({ loggerService: { withContext: () => mockLogger } }))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => paths.tempRoot),
    getVersion: vi.fn(() => '1.0.0'),
    relaunch: vi.fn(),
    exit: vi.fn()
  }
}))

// WindowService 在模块求值期构造 ThemeService（读 electron.nativeTheme）。本测试不涉及窗口，
// 按 BackupManager.test.ts 同款接缝替换。
vi.mock('../WindowService', () => ({ windowService: { getMainWindow: vi.fn() } }))
vi.mock('../WebDav', () => ({ default: vi.fn() }))
vi.mock('../../utils', () => ({ getDataPath: vi.fn(() => `${paths.tempRoot}/userData/Data`) }))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import BackupManager from '../BackupManager'

describe('BackupManager 暂存目录独占 (m2-11)', () => {
  let manager: BackupManager
  let runRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    // 仓规约定：临时根建在 os.tmpdir()，用例结束整树删除（同 ObsidianVaultService / FileStorage 测试）。
    // 旧写法建在 process.cwd() 且没有 afterEach：每跑一次 suite 就在仓库根留下一个
    // `.tmp-backup-m2-11-*`，而 .gitignore 只覆盖 `.tmp-kernel-*-tests*`，于是污染 git status。
    runRoot = fs.mkdtempSync(path.join(os.tmpdir(), '.tmp-backup-m2-11-'))
    paths.tempRoot = runRoot
    fs.mkdirSync(path.join(runRoot, 'userData', 'IndexedDB'), { recursive: true })
    fs.writeFileSync(path.join(runRoot, 'userData', 'IndexedDB', 'marker.txt'), 'x')
    manager = new BackupManager()
  })

  afterEach(() => {
    fs.rmSync(runRoot, { recursive: true, force: true })
  })

  it('连续两次 backup() 各自清理独占暂存目录，产物都在', async () => {
    const tempRoot = path.join(runRoot, 'cherry-studio', 'backup', 'temp')
    const backupDir = path.join(runRoot, 'cherry-studio', 'backup')

    await manager.backup({} as Electron.IpcMainInvokeEvent, 'one.zip')
    expect(fs.readdirSync(tempRoot)).toEqual([])
    await manager.backup({} as Electron.IpcMainInvokeEvent, 'two.zip')
    expect(fs.readdirSync(tempRoot)).toEqual([])

    expect(fs.existsSync(path.join(backupDir, 'one.zip'))).toBe(true)
    expect(fs.existsSync(path.join(backupDir, 'two.zip'))).toBe(true)
  })

  it('并发 backup() 各自持有独占暂存根，结尾互不踩踏', async () => {
    const tempRoot = path.join(runRoot, 'cherry-studio', 'backup', 'temp')
    const destA = path.join(runRoot, 'dest-a')
    const destB = path.join(runRoot, 'dest-b')
    fs.mkdirSync(destA, { recursive: true })
    fs.mkdirSync(destB, { recursive: true })

    const created: string[] = []
    const originalCreateTempDir = (manager as unknown as { createTempDir: () => Promise<string> }).createTempDir.bind(
      manager
    )
    const impl = async () => {
      const dir = await originalCreateTempDir()
      created.push(dir)
      if (created.length === 2) {
        // 第二个调用故意慢一拍再返回，制造真实重叠：两个暂存根同时存活。
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      return dir
    }
    ;(manager as unknown as { createTempDir: () => Promise<string> }).createTempDir = impl

    try {
      await Promise.all([
        manager.backup({} as Electron.IpcMainInvokeEvent, 'a.zip', destA),
        manager.backup({} as Electron.IpcMainInvokeEvent, 'b.zip', destB)
      ])
    } finally {
      ;(manager as unknown as { createTempDir: () => Promise<string> }).createTempDir = originalCreateTempDir
    }

    // 两次调用各自 mkdtemp 一个 run-* 暂存根
    expect(created).toHaveLength(2)
    expect(new Set(created).size).toBe(2)
    for (const dir of created) {
      expect(path.dirname(dir)).toBe(tempRoot)
    }
    // 两个归档都产出且互不污染（旧写法共享一个 tempDir：先完成者 remove 会踩掉后来者的中间目录）
    expect(fs.existsSync(path.join(destA, 'a.zip'))).toBe(true)
    expect(fs.existsSync(path.join(destB, 'b.zip'))).toBe(true)
    expect(fs.readdirSync(destA)).toEqual(['a.zip'])
    expect(fs.readdirSync(destB)).toEqual(['b.zip'])
    // 暂存根用完即清（各自的目录各自清）
    expect(fs.readdirSync(tempRoot)).toEqual([])
    // 期间没有静默失败
    expect(mockLogger.error).not.toHaveBeenCalled()
  })
})
