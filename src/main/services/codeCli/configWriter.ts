// fork 移植自 cherry-studio v2 src/main/services/codeCli/configWriter.ts（2026-09-24，v0.3.4-1）。
// 缝点：① V2 的 @main/utils/file（atomicWriteFile/ensureDir/read/remove）→ fork 的
// atomicFile.ts + 内联 fs.promises 包装；② application.getPath('sys.home') → os.homedir()；
// ③ AbsoluteFilePath 品牌类型退化（见 config.ts 缝③）；④ target 表已裁到 hermes 两项。

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { atomicWriteFile } from '@main/utils/atomicFile'
import type { CliConfigTarget, CliConfigWriteFile, FileConfiguredCli } from '@shared/utils/cliConfig'
import { CLI_CONFIG_FILE_SPECS, getCliConfigTargets } from '@shared/utils/cliConfig'

import { getHermesHome } from './hermesHome'

const logger = loggerService.withContext('CodeCliConfigWriter')

/** CLI config files carry credentials — owner-only from birth. */
const CLI_CONFIG_FILE_MODE = 0o600

interface FileSnapshot {
  absPath: string
  existed: boolean
  previousContent: string
}

/** Resolve a declarative target path against its base: the pinned Hermes home, or sys.home for `~/…` spec paths. */
// fork 缝②③：本仓 target 表只剩 hermes-home 基（hermes 两 target），`~/…` 分支保留
// 以维持 V2 形状（当前不可达——无 `~` 路径 target）。
async function resolveTargetPath(target: CliConfigTarget): Promise<string> {
  const { pathBase, path: specPath } = CLI_CONFIG_FILE_SPECS[target]
  if (pathBase === 'hermes-home') {
    return path.join(await getHermesHome(), specPath)
  }
  return path.join(os.homedir(), specPath.replace(/^~[/\\]/, ''))
}

async function readOrNull(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** One config file's read result for `code_cli.read_config`: `content === null` ⇔ the file does not exist. */
export interface CliConfigReadFile {
  target: CliConfigTarget
  path: string
  content: string | null
}

/**
 * Batch read of CLI config files — the read counterpart of `writeCliConfigFiles`
 * (same `resolveTargetPath` resolution, so reads and writes address identical paths).
 * ENOENT maps to `content: null`; any other read error aborts and rethrows.
 * Duplicate targets are deduplicated by the route schema, not here.
 */
export async function readCliConfigFiles(targets: readonly CliConfigTarget[]): Promise<CliConfigReadFile[]> {
  return Promise.all(
    targets.map(async (target) => {
      const path = await resolveTargetPath(target)
      return { target, path, content: await readOrNull(path) }
    })
  )
}

/**
 * Transactional batch write of a file-configured CLI's config files — the only
 * disk-write path for `code_cli.write_config`. The target enum is the write
 * allow-list (the renderer never sends a path); this only re-checks that each
 * target belongs to `cliTool` and appears once.
 *
 * Per file, in batch order: snapshot → atomic 0600 write or hard delete.
 * The first failure rolls back in reverse order (restore previous content, hard
 * unlink files that did not exist — never the trash, they may hold secrets) and
 * rethrows the ORIGINAL error; rollback failures are logged, never thrown.
 */
export async function writeCliConfigFiles(cliTool: FileConfiguredCli, files: CliConfigWriteFile[]): Promise<void> {
  const allowed = new Set(getCliConfigTargets(cliTool))
  const seen = new Set<CliConfigTarget>()
  for (const file of files) {
    if (!allowed.has(file.target)) {
      throw new Error(`${file.target} is not a config file of ${cliTool}`)
    }
    if (seen.has(file.target)) {
      throw new Error(`Duplicate config target: ${file.target}`)
    }
    seen.add(file.target)
  }

  const snapshots: FileSnapshot[] = []
  try {
    for (const file of files) {
      const absPath = await resolveTargetPath(file.target)
      const previousContent = await readOrNull(absPath)
      snapshots.push({ absPath, existed: previousContent !== null, previousContent: previousContent ?? '' })
      if ('delete' in file) {
        await fs.unlink(absPath)
        logger.info(`Deleted ${cliTool} config at ${absPath}`)
      } else {
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await atomicWriteFile(absPath, file.content, { mode: CLI_CONFIG_FILE_MODE })
        logger.info(`Applied ${cliTool} config to ${absPath}`)
      }
    }
  } catch (error) {
    for (const snapshot of snapshots.slice().reverse()) {
      if (snapshot.existed) {
        await atomicWriteFile(snapshot.absPath, snapshot.previousContent, { mode: CLI_CONFIG_FILE_MODE }).catch(
          (rollbackError) =>
            logger.error(`Failed to roll back ${snapshot.absPath} after write failure`, rollbackError as Error)
        )
      } else {
        await fs.unlink(snapshot.absPath).catch((rollbackError) =>
          logger.error(`Failed to delete ${snapshot.absPath} during rollback`, rollbackError as Error)
        )
      }
    }
    throw error
  }
}
