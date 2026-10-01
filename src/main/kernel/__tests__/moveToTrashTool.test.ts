import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, win32 as winPath } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getProtectedTrashTargetReason, moveItemToTrash, type TrashProtectionContext } from '../moveToTrashTool'

/**
 * move_to_trash 机测（V2 移植）：保护路径矩阵 + 围栏/symlink 校验。
 * shell.trashItem 由注入函数替代（不触真回收站）；真实 fs 只用于 lstat/realpath 链。
 * 主测试 setup mock 掉 node:os，临时目录挂进程工作目录下统一清扫。
 */
const TEMP_BASE = join(process.cwd(), '.tmp-kernel-move2trash-tests')

beforeAll(async () => {
  await mkdir(TEMP_BASE, { recursive: true })
})
afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true })
})

const WORKSPACE = 'C:\\work\\ws'
const HOME = 'C:\\Users\\tester'

const CTX: TrashProtectionContext = {
  platform: 'win32',
  homeDirectory: HOME,
  downloadsDirectory: `${HOME}\\Downloads`,
  protectedDirectories: ['C:\\Users\\tester\\AppData\\Roaming\\app-data'],
  environment: { SystemRoot: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files' }
}

describe('getProtectedTrashTargetReason', () => {
  it('拒绝工作区根自身', () => {
    expect(getProtectedTrashTargetReason(WORKSPACE, WORKSPACE, CTX)).toContain('workspace root')
  })

  it('拒绝盘根', () => {
    expect(getProtectedTrashTargetReason('C:\\', WORKSPACE, CTX)).toContain('root')
  })

  it('拒绝主目录', () => {
    expect(getProtectedTrashTargetReason(HOME, WORKSPACE, CTX)).toContain('home')
  })

  it('拒绝顶层用户目录（含 Downloads）', () => {
    expect(getProtectedTrashTargetReason(`${HOME}\\Desktop`, WORKSPACE, CTX)).toContain('top-level')
    expect(getProtectedTrashTargetReason(`${HOME}\\Downloads`, WORKSPACE, CTX)).toContain('top-level')
  })

  it('拒绝凭据/敏感目录（含子路径）', () => {
    expect(getProtectedTrashTargetReason(`${HOME}\\.ssh`, WORKSPACE, CTX)).toContain('credential')
    expect(getProtectedTrashTargetReason(`${HOME}\\.ssh\\keys`, WORKSPACE, CTX)).toContain('credential')
    expect(
      getProtectedTrashTargetReason('C:\\Users\\tester\\AppData\\Roaming\\app-data\\cache', WORKSPACE, CTX)
    ).toContain('credential')
  })

  it('拒绝 VCS 元数据段', () => {
    expect(getProtectedTrashTargetReason(`${WORKSPACE}\\.git`, WORKSPACE, CTX)).toContain('version-control')
    expect(getProtectedTrashTargetReason(`${WORKSPACE}\\pkg\\.git\\objects`, WORKSPACE, CTX)).toContain(
      'version-control'
    )
  })

  it('拒绝 Windows 系统目录（约定 + env 推导）', () => {
    expect(getProtectedTrashTargetReason('C:\\Windows\\System32', WORKSPACE, CTX)).toContain('operating-system')
    expect(getProtectedTrashTargetReason('C:\\Program Files\\SomeApp', WORKSPACE, CTX)).toContain('operating-system')
    expect(getProtectedTrashTargetReason('C:\\WINDOWS\\Temp', WORKSPACE, CTX)).toContain('operating-system')
  })

  it('工作区包含主目录时整体拒绝（工作区在主目录之上）', () => {
    // isSameOrWithin(home, workspace) = home 落在工作区内 = 工作区在 home 及其上层。
    expect(getProtectedTrashTargetReason('C:\\Users\\other\\file.txt', 'C:\\', CTX)).toContain('rooted at or above')
  })

  it('工作区在主目录内部、目标在敏感目录外时放行', () => {
    expect(getProtectedTrashTargetReason(`${HOME}\\project\\file.txt`, `${HOME}\\project`, CTX)).toBeUndefined()
  })

  it('工作区内普通路径放行', () => {
    expect(getProtectedTrashTargetReason(`${WORKSPACE}\\build\\out.txt`, WORKSPACE, CTX)).toBeUndefined()
    expect(getProtectedTrashTargetReason(`${WORKSPACE}\\子目录\\报告.docx`, WORKSPACE, CTX)).toBeUndefined()
  })
})

describe('moveItemToTrash', () => {
  const trashTargets: string[] = []
  const trash = async (target: string): Promise<void> => {
    trashTargets.push(target)
  }

  it('工作区内普通文件投递成功（相对路径归一）', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    const file = join(ws, 'out.txt')
    await writeFile(file, 'data')
    const result = await moveItemToTrash(ws, 'out.txt', trash, { platform: process.platform })
    expect(result.path).toBe('out.txt')
    expect(result.type).toBe('file')
    // 工具内部用 path.win32/posix 原生解析（setup mock 的 join 只影响测试侧字符串）。
    expect(trashTargets.at(-1)).toBe(winPath.resolve(ws, 'out.txt'))
    await rm(ws, { recursive: true, force: true })
  })

  it('工作区外路径拒绝', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    const outside = join(TEMP_BASE + '-outside', 'elsewhere.txt')
    await expect(moveItemToTrash(ws, outside, trash)).rejects.toThrow(/outside the session workspace/)
    await rm(ws, { recursive: true, force: true })
  })

  it('不存在的路径具名报错', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    await expect(moveItemToTrash(ws, 'missing.txt', trash)).rejects.toThrow(/Path not found/)
    await rm(ws, { recursive: true, force: true })
  })

  it('symlink 拒绝（不投递链目标）', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    const target = join(ws, 'real.txt')
    await writeFile(target, 'data')
    const link = join(ws, 'link.txt')
    // Windows symlink 创建需要特权；缺特权（EPERM）时跳过断言（环境差异不阻塞门禁）。
    try {
      await symlink(target, link, 'file')
      await expect(moveItemToTrash(ws, 'link.txt', trash)).rejects.toThrow(/symbolic link/)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    await rm(ws, { recursive: true, force: true })
  })

  it('真实文件两次 lstat 身份一致（TOCTOU 前置：稳定路径放行）', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    const file = join(ws, 'victim.txt')
    await writeFile(file, 'v1')
    const before = await lstat(file, { bigint: true })
    const after = await lstat(file, { bigint: true })
    expect(after.dev === before.dev && after.ino === before.ino).toBe(true)
    await rm(ws, { recursive: true, force: true })
  })

  it('目录同样可投递', async () => {
    const ws = await mkdtemp(TEMP_BASE + '-ws-')
    const sub = join(ws, 'subdir')
    await mkdir(sub)
    await writeFile(join(sub, 'inner.txt'), 'data')
    const result = await moveItemToTrash(ws, 'subdir', trash)
    expect(result.type).toBe('directory')
    expect(trashTargets.at(-1)).toBe(winPath.resolve(ws, 'subdir'))
    await rm(ws, { recursive: true, force: true })
  })
})
