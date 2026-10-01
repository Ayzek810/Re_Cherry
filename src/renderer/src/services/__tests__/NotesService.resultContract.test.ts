/**
 * notes 页全部写操作失败只落日志，用户看不到任何信号。
 *
 * 本文件钉住服务层那两条被点名的契约，页面侧的 toast 由 `NotesPage` 的 catch 承担：
 *   ① `renameNode` 把"重名"当**业务结果**返回（`ok:false` + `reason:'conflict'`），不再 `throw`——
 *      旧实现抛 `Target name already exists`，页面只能落日志，用户看到的是"点了没反应"；
 * ② `delNode` 按 删除纪律返回 `Promise<boolean>`，调用方能区分成败；真实失败仍原样抛出。
 */
import type { NotesTreeNode } from '@renderer/types/note'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { delNode, renameNode } from '../NotesService'

const checkFileName = vi.fn()
const renameFile = vi.fn()
const renameDir = vi.fn()
const deleteExternalFile = vi.fn()
const deleteExternalDir = vi.fn()

function node(overrides: Partial<NotesTreeNode> = {}): NotesTreeNode {
  return {
    id: 'n-1',
    name: 'alpha',
    type: 'file',
    treePath: 'alpha',
    externalPath: 'C:/notes/alpha.md',
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('NotesService 写路径的结果契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = {
      file: { checkFileName, rename: renameFile, renameDir, deleteExternalFile, deleteExternalDir }
    }
  })

  it('renameNode：重名返回冲突业务结果，不抛异常', async () => {
    checkFileName.mockResolvedValue({ safeName: 'beta', exists: true })

    const result = await renameNode(node(), 'beta')

    expect(result).toEqual({ ok: false, reason: 'conflict', safeName: 'beta' })
    expect(renameFile).not.toHaveBeenCalled()
    expect(renameDir).not.toHaveBeenCalled()
  })

  it('renameNode：成功返回新路径与新名字', async () => {
    checkFileName.mockResolvedValue({ safeName: 'gamma', exists: false })
    renameFile.mockResolvedValue(undefined)

    const result = await renameNode(node(), 'gamma')

    expect(result).toEqual({ ok: true, path: 'C:/notes/gamma.md', name: 'gamma' })
    expect(renameFile).toHaveBeenCalledWith('C:/notes/alpha.md', 'gamma')
  })

  it('renameNode：文件夹重名同样走冲突结果', async () => {
    checkFileName.mockResolvedValue({ safeName: 'docs', exists: true })

    const result = await renameNode(node({ type: 'folder', externalPath: 'C:/notes/old' }), 'docs')

    expect(result).toEqual({ ok: false, reason: 'conflict', safeName: 'docs' })
  })

  it('renameNode：非冲突的底层失败原样抛出（由页面 presentToast）', async () => {
    checkFileName.mockResolvedValue({ safeName: 'gamma', exists: false })
    renameFile.mockRejectedValue(new Error('EPERM: file is locked'))

    await expect(renameNode(node(), 'gamma')).rejects.toThrow('EPERM')
  })

  it('delNode：成功返回 true（Promise<boolean> 纪律）', async () => {
    deleteExternalFile.mockResolvedValue(undefined)

    await expect(delNode(node())).resolves.toBe(true)
    expect(deleteExternalFile).toHaveBeenCalledWith('C:/notes/alpha.md')
  })

  it('delNode：文件夹走 deleteExternalDir', async () => {
    deleteExternalDir.mockResolvedValue(undefined)

    await expect(delNode(node({ type: 'folder', externalPath: 'C:/notes/dir' }))).resolves.toBe(true)
    expect(deleteExternalDir).toHaveBeenCalledWith('C:/notes/dir')
  })

  it('delNode：删除失败原样抛出（页面据此弹 toast.error，不再静默）', async () => {
    deleteExternalFile.mockRejectedValue(new Error('EBUSY: resource busy'))

    await expect(delNode(node())).rejects.toThrow('EBUSY')
  })
})
