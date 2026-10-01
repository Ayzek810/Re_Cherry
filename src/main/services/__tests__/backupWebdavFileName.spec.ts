/**
 *
 * 缺陷：本地还原/删除走 `resolveAndValidatePath(localBackupDir, fileName)`，而 WebDAV 两条
 * 完全绕开它，直接把渲染层给的 `webdavConfig.fileName` 交给 `path.join(this.backupDir, filename)`
 * 与 `putFileContents(filename, ...)`。`fileName = '../../../Documents/x.zip'` 可让写盘/读出
 * 落在 backupDir 之外（restoreFromWebdav 会**覆盖**目标路径）。
 *
 * 修法：WebDAV 远端文件名先过结构化断言，本地落点再由 resolveAndValidatePath 兜住根目录；
 * 两处 `path.join(destinationPath, fileName)` 也统一改走该原语。
 */
import { describe, expect, it, vi } from 'vitest'

// BackupManager 经 WindowService 拉进 `@electron-toolkit/utils` 的 CJS 链（该链在 vitest
// 下绕过 setup 的 electron 桩）。本文件只验证文件名校验，故把无关的模块级依赖缝桩掉。
vi.mock('../WindowService', () => ({ windowService: { getMainWindow: vi.fn() } }))
vi.mock('../WebDav', () => ({ default: vi.fn() }))
vi.mock('../ProviderKeyStore', () => ({ providerKeyStore: { getAll: vi.fn(() => ({})), setMany: vi.fn() } }))
vi.mock('../../utils', () => ({ getDataPath: vi.fn(() => '/mock/data') }))

import { assertSafeRemoteBackupFileName } from '../BackupManager'

describe('assertSafeRemoteBackupFileName', () => {
  it('accepts a plain file name and trims surrounding whitespace', () => {
    expect(assertSafeRemoteBackupFileName('cherry-studio.backup.zip')).toBe('cherry-studio.backup.zip')
    expect(assertSafeRemoteBackupFileName('  cherry-studio.backup.zip  ')).toBe('cherry-studio.backup.zip')
  })

  it('accepts a nested remote path (a sub-directory on the WebDAV bucket)', () => {
    expect(assertSafeRemoteBackupFileName('backups/2026/cherry-studio.backup.zip')).toBe(
      'backups/2026/cherry-studio.backup.zip'
    )
  })

  it('rejects parent-directory traversal', () => {
    for (const value of ['../../../Documents/x.zip', '..\\..\\Windows\\evil.zip', 'a/../../b.zip', 'sub/..', '..']) {
      expect(() => assertSafeRemoteBackupFileName(value)).toThrow(/parent-directory segment/)
    }
  })

  it('rejects absolute paths (POSIX and Windows shapes)', () => {
    for (const value of ['/etc/cron.d/x.zip', '\\\\server\\share\\x.zip', 'C:\\temp\\x.zip', 'c:/temp/x.zip']) {
      expect(() => assertSafeRemoteBackupFileName(value)).toThrow(/absolute path/)
    }
  })

  it('rejects empty names and NUL bytes', () => {
    expect(() => assertSafeRemoteBackupFileName('')).toThrow(/empty/)
    expect(() => assertSafeRemoteBackupFileName('   ')).toThrow(/empty/)
    expect(() => assertSafeRemoteBackupFileName('a\0b.zip')).toThrow(/NUL byte/)
  })
})
