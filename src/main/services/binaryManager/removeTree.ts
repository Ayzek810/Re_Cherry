// fork 缝（原创+社区移植混合，2026-09-24 v0.3.4-2 批次0）：
// - 逐项遍历删除：移植自社区 dsh-desktop packages/dsh-desktop-market-installer/remove-tree.mjs
//   （MIT）——修复 Windows 两坑：①Node 递归 rm 对非 ASCII 路径静默失败（rmSync 报成功但
//   什么都没删，社区原文有实证）；②symlink 用 unlink 断链而不跟进（防把 pnpm store 内容
//   连带删除）。批次5 起我们的 profile 树会引入 pnpm link，此纪律前移。
// - removeTreeWithRetry：批次5 真机事故（EPERM on sharp .node）——进程 taskkill 后
//   Windows 释放原生 DLL 锁是异步的（Defender 扫描/句柄回收延迟），立即 rm 撞 EPERM。
//   重试退避到锁释放；仍失败如实上报由 UI 引导稍后重试。
//
// v0.4.5-1（真机反馈"卸载还是耗时过长"）：**原生递归 rm 成为常规路径，逐项遍历降为兜底**。
// 本机实测（受管 hermes 树的一份拷贝，11074 个项 / 161 MB）：
//   逐项遍历 15497 ms   ·   `rm --recursive` 4852 ms   ·   3.2×
// 逐项遍历慢的原因是它把每个文件都变成一个 await 往返（Windows + Defender 下每次都是真 I/O），
// 而卸载一棵 venv / node_modules 是万级到十万级文件。
//
// 两条纪律仍然成立，且是**核验式**成立，不是靠信任：
//   ① "rm 静默失败"（非 ASCII 路径）→ 删完必须 lstat 核验；还在就交给逐项遍历兜底（它本来
//      就是为这个 bug 写的）；
//   ② "不跟进 symlink/junction" → 已实测（本机）：Windows junction 上 `rm --recursive` **只删
//      链接、不动目标**（目标的文件完好），与逐项遍历的 unlink 语义一致；单测把这条实测钉住。

import { lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('RemoveTree')

const REMOVE_RETRY_MAX = 5
const REMOVE_RETRY_DELAY_MS = 800

/**
 * 原生 rm 自带的重试窗口（Windows 杀软/句柄异步释放）。它比"整棵树重试一轮"便宜得多，
 * 所以常规的小锁由它自己消化，整棵树的退避只留给兜底路径。
 */
const NATIVE_REMOVE_RETRIES = 3
const NATIVE_REMOVE_RETRY_DELAY_MS = 150

/** 存在性核验（不跟进链接：lstat）。 */
async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error) => (error as NodeJS.ErrnoException).code !== 'ENOENT'
  )
}

/** 原生递归删除（默认端口）；force: true → 路径不存在不算错（本函数的既有语义）。 */
function nativeRemove(target: string): Promise<void> {
  return rm(target, {
    recursive: true,
    force: true,
    maxRetries: NATIVE_REMOVE_RETRIES,
    retryDelay: NATIVE_REMOVE_RETRY_DELAY_MS
  })
}

export interface RemoveTreeOptions {
  /**
   * 原生递归删除端口（默认 `rm --recursive --force`）。
   *
   * 存在的理由与 downloadFile 的 sink 端口同款：让"快路径 → 核验 → 兜底"这三步可被单测
   * 分别驱动——注入一个什么都不做的端口，就复现了 Windows"非 ASCII 路径静默失败"那一类，
   * 于是"核验必须接住它"成了被测试钉住的契约，而不是注释里的承诺。
   */
  nativeRemove?: (target: string) => Promise<void>
}

/**
 * Remove a file or directory tree.
 *
 * 常规路径是原生递归 rm（实测 3.2× 快）；核验发现还在（被占用，或命中"非 ASCII 路径静默失败"
 * 那个 Windows 坑）才走逐项遍历兜底。两种路径都不跟进 symlink/junction。
 */
export async function removeTree(target: string, options: RemoveTreeOptions = {}): Promise<void> {
  const fastRemove = options.nativeRemove ?? nativeRemove
  await fastRemove(target).catch((error) => {
    // 不在这里上抛：核验才是判据（被占用的项留在原处，交给兜底/上层重试）。
    logger.debug(`removeTree: native rm did not finish for ${target}`, error as Error)
  })
  if (!(await exists(target))) return
  await removeTreeEntryByEntry(target)
}

/**
 * Remove a file or directory tree, entry by entry (no recursive rm).
 * - A symlink is unlinked, never followed (protects store contents).
 * - A missing path is not an error.
 */
async function removeTreeEntryByEntry(target: string): Promise<void> {
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
    await removeTreeEntryByEntry(path.join(target, child.name))
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
