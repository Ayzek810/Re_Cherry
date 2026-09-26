// fork 缝（原创+社区移植混合，2026-09-24 v0.3.4-2 批次0）：
// - removeTree 逐项遍历：移植自社区 dsh-desktop packages/dsh-desktop-market-installer/remove-tree.mjs
//   （MIT）——修复 Windows 两坑：①Node 递归 rm 对非 ASCII 路径静默失败（rmSync 报成功但
//   什么都没删，社区原文有实证）；②symlink 用 unlink 断链而不跟进（防把 pnpm store 内容
//   连带删除）。批次5 起我们的 profile 树会引入 pnpm link，此纪律前移。
// - removeTreeWithRetry：批次5 真机事故（EPERM on sharp .node）——进程 taskkill 后
//   Windows 释放原生 DLL 锁是异步的（Defender 扫描/句柄回收延迟），立即 rm 撞 EPERM。
//   重试退避到锁释放；仍失败如实上报由 UI 引导稍后重试。

import { lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('RemoveTree')

const REMOVE_RETRY_MAX = 5
const REMOVE_RETRY_DELAY_MS = 800

/**
 * Remove a file or directory tree, entry by entry (no recursive rm).
 * - A symlink is unlinked, never followed (protects store contents).
 * - A missing path is not an error.
 */
export async function removeTree(target: string): Promise<void> {
  let entry
  try {
    entry = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    await unlink(target)
    return
  }

  for (const child of await readdir(target, { withFileTypes: true })) {
    await removeTree(path.join(target, child.name))
  }
  await rmdir(target)
}

/** Remove a tree, reporting whether it is gone rather than throwing. */
export async function removeTreeIfPossible(target: string): Promise<boolean> {
  try {
    await removeTree(target)
  } catch {
    // Fall through to the presence check: a partial removal still counts for nothing.
  }
  try {
    await lstat(target)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Remove a tree with EPERM/EBUSY retry backoff（Windows 原生模块锁异步释放竞态）。
 * 重试穷尽后仍存在 → false（调用方如实上报"文件被占用，稍后重试"）。
 */
export async function removeTreeWithRetry(target: string): Promise<boolean> {
  for (let attempt = 1; attempt <= REMOVE_RETRY_MAX; attempt++) {
    const gone = await removeTreeIfPossible(target)
    if (gone) return true
    logger.warn(`removeTree: ${target} still present (locked?), retry ${attempt}/${REMOVE_RETRY_MAX}`)
    await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS * attempt))
  }
  return false
}

/** Convenience: force-style removal used by the uninstaller paths. */
export async function removeTreeForce(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
}
