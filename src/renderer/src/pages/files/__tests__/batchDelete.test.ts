/**
 * 文件页批量删除的结果契约。
 *
 * 旧实现 `await Promise.all(validFiles.map((file) => handleDelete(file.id, t)))`：
 * 任一删除 reject 就整体抛出，`setSelectedFileIds([])` 不再执行，Popconfirm 的 onConfirm 也
 * 没人接住这个 rejection——界面停在选中态且没有任何提示；成功/失败还从不计数
 * 「A batch deletion reports "N succeeded / M failed" as a real signal」。
 *
 * 行为级断言：① 一个文件的失败不取消其余文件的删除；② 结局可分辨地分成成功/失败两组。
 */
import { describe, expect, it, vi } from 'vitest'

import { runBatchDelete } from '../batchDelete'

describe('runBatchDelete（批量删除收全结果）', () => {
  it('全部成功：succeededIds 覆盖全部，failures 为空', async () => {
    const deleteOne = vi.fn().mockResolvedValue(undefined)

    const outcome = await runBatchDelete(['a', 'b', 'c'], deleteOne)

    expect(outcome.succeededIds).toEqual(['a', 'b', 'c'])
    expect(outcome.failures).toEqual([])
    expect(deleteOne).toHaveBeenCalledTimes(3)
  })

  it('中间项失败：其余项仍然被删（旧实现的 Promise.all 会在这里整体抛出）', async () => {
    const failure = new Error('EBUSY')
    const deleteOne = vi.fn((fileId: string) => (fileId === 'b' ? Promise.reject(failure) : Promise.resolve()))

    const outcome = await runBatchDelete(['a', 'b', 'c'], deleteOne)

    expect(deleteOne).toHaveBeenCalledTimes(3)
    expect(outcome.succeededIds).toEqual(['a', 'c'])
    expect(outcome.failures).toEqual([{ fileId: 'b', reason: failure }])
  })

  it('全部失败：failures 逐项带原因，succeededIds 为空（页面据此保留选中项重试）', async () => {
    const deleteOne = vi.fn().mockRejectedValue(new Error('IPC unavailable'))

    const outcome = await runBatchDelete(['a', 'b'], deleteOne)

    expect(outcome.succeededIds).toEqual([])
    expect(outcome.failures.map((item) => item.fileId)).toEqual(['a', 'b'])
    expect((outcome.failures[0].reason as Error).message).toBe('IPC unavailable')
  })
})
