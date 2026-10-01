// 二轮审查 f2-39（fork 原创缝模块）：批量删除的结果契约。
//
// 旧实现是 `await Promise.all(validFiles.map((file) => handleDelete(file.id, t)))`：
// ① 任一删除 reject（IPC 断链、Dexie 写失败）就整体抛出，`setSelectedFileIds([])` 不再执行，
//    Popconfirm 的 onConfirm 又没人接住这个 rejection —— 界面停在选中态且没有任何提示；
// ② 成功与失败都不计数，§9「A batch deletion reports "N succeeded / M failed" as a real signal」
//    落不了地。
// 本模块只做一件事：逐个跑完并**收全**结果，把"哪几个成了、哪几个败了、败在哪"交给页面呈现。

export interface BatchDeleteFailure {
  fileId: string
  reason: unknown
}

export interface BatchDeleteOutcome {
  succeededIds: string[]
  failures: BatchDeleteFailure[]
}

/**
 * 逐个执行删除，收全全部结果。
 *
 * 用 `allSettled` 而不是 `all`：契约要的是"每个文件的结局"，不是"第一个失败"。一个文件的
 * 失败不得取消其余文件的删除，也不得让调用方拿不到已完成的部分。
 */
export async function runBatchDelete(
  fileIds: string[],
  deleteOne: (fileId: string) => Promise<void>
): Promise<BatchDeleteOutcome> {
  const results = await Promise.allSettled(fileIds.map((fileId) => deleteOne(fileId)))

  const succeededIds: string[] = []
  const failures: BatchDeleteFailure[] = []

  results.forEach((result, index) => {
    const fileId = fileIds[index]
    if (result.status === 'fulfilled') {
      succeededIds.push(fileId)
    } else {
      failures.push({ fileId, reason: result.reason })
    }
  })

  return { succeededIds, failures }
}
