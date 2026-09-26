// fork 缝：不整体搬 V2 的 atomicWriteFile（V2 src/main/utils/file/fs.ts，依赖其 FileManager
// 路径系统与 entry-tree/orphanSweep 机制）；按 V2 同名函数语义写的极简版：
// 同目录 tmp（同 mode）→ rename 覆盖，rename 失败（EXDEV/EPERM）回退 copyFile+unlink，
// 任何失败都清理 tmp 并重抛；tmp 清理失败非 ENOENT 时记 warn（消息沿用 V2 原文）。
import { randomBytes } from 'crypto'
import { copyFile, rename, unlink, writeFile } from 'fs/promises'

import { loggerService } from '@logger'

const logger = loggerService.withContext('Utils:AtomicFile')

export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  options?: { mode?: number }
): Promise<void> {
  const tmp = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data, { mode: options?.mode })
    try {
      await rename(tmp, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM') throw error
      await copyFile(tmp, target)
      await unlink(tmp)
    }
  } catch (error) {
    try {
      await unlink(tmp)
    } catch (cleanupError) {
      const code = (cleanupError as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        logger.warn('atomicWriteFile: tmp cleanup failed; tmp file may remain on disk', {
          tmp,
          target,
          code,
          err: cleanupError
        })
      }
    }
    throw error
  }
}
