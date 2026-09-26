// fork 缝：受管 CLI 二进制解析（2026-09-24，v0.3.4-1；批次2 升级；批次5 补能力探针）。
// 解析顺序：CodeMate 受管目录（tools/ 子树）→ 系统 PATH（where/which）。受管探测在本文件
// 内联（刻意不 import BinaryManager——依赖方向保持 resolveBinary（低层）← BinaryManager（高层）
// 单向；BinaryManager 反向复用本文件的 probeSystemPath）。受管布局映射与 BinaryManager 的
// managedBinaryPath 保持一致：executable 'dsh' → npm 型（node_modules/.bin），'hermes' →
// venv 型（Scripts/bin）；其他 executable 不查受管。
//
// 批次5 真机事故加固：批次2 的探测是"PATH 命中即可用"——不验能否运行、不验版本，系统 PATH
// 上的同名异物（旧版缺子命令、pipx 装的时候没带 [web] extras、损坏安装）照样被打上可用
// 标签放行启动，最后炸一句 "exited before it was ready"（V2 的对位语义是 availability
// 授权执行、application 授权变更；V2 探测含 realpath/归属/版本，fork 裁掉后无替代）。
// 现补 `--version` 能力探针：能跑且报出版本 → runnable:true + version；否则 runnable:false
// ——快照层标 broken，服务层启动前显式拒绝（不再靠子进程退出后的英文哑弹）。
// 批次5 二次真机事故：探针原用裸 execFile——Windows 上 .cmd/.bat 不经 shell 直接 spawn 是
// EINVAL（CVE-2024-27980 防护，Node 同步 throw），受管 dsh 恰好是 node_modules/.bin/dsh.cmd
// → 快照通道每 2s 炸一次。改用 V2 processRunner 的 executeCommand（内部 cross-spawn，
// .cmd 转发已处理）——用户裁决"复制 V2 现成代码，别手搓"。probeSystemPath 的 where/which
// 是真实 .exe，保留 execFile 无碍。

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { isWin } from '@main/constant'
import { codeMateToolsRoot } from '@main/services/deepSeekHarness/paths'
import { executeCommand } from '@main/utils/processRunner'

const logger = loggerService.withContext('ResolveBinary')

export interface ResolvedBinary {
  source: 'system' | 'managed'
  path: string
  /** `--version` 探针输出首行（截断）；探针失败为 undefined。 */
  version?: string
  /** 二进制可运行（`--version` 退出码 0）。false ⇒ 快照层标 broken、启动层拒绝。 */
  runnable: boolean
}

export function probeSystemPath(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const command = isWin ? 'where' : 'which'
    execFile(command, [executable], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined)
      const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim()
      resolve(firstLine || undefined)
    })
  })
}

/** `--version` 能力探针：能跑且非空输出 → {runnable:true, version}；否则 runnable:false。
 * 批次5 二次真机事故修复：原用裸 execFile（.cmd 直接 spawn EINVAL），换 V2 现成的
 * executeCommand（内部 cross-spawn 处理 .cmd 转发）。非零退出/超时 → 不能跑（诊断留日志）。 */
export async function probeBinary(binPath: string): Promise<{ runnable: boolean; version?: string }> {
  try {
    const stdout = await executeCommand(binPath, ['--version'], { timeout: 5000 })
    const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim().slice(0, 80)
    return { runnable: true, version: firstLine || undefined }
  } catch {
    logger.info(`code-mate: probe --version failed for ${binPath}`)
    return { runnable: false }
  }
}

/** 受管布局映射：仅本 fork 的两个受管工具查受管目录，其余 executable 恒返回 undefined。 */
function managedBinaryPath(executable: string): string | undefined {
  const toolsRoot = codeMateToolsRoot()
  if (executable === 'dsh') {
    return path.join(toolsRoot, 'dsh', 'node_modules', '.bin', isWin ? 'dsh.cmd' : 'dsh')
  }
  if (executable === 'hermes') {
    return isWin ? path.join(toolsRoot, 'hermes', 'Scripts', 'hermes.exe') : path.join(toolsRoot, 'hermes', 'bin', 'hermes')
  }
  return undefined
}

/** 解析受管 CLI 的可执行文件（受管优先，回退系统 PATH）；找不到返回 null（调用方给用户可见错误）。 */
export async function resolveBinary(executable: string): Promise<ResolvedBinary | null> {
  const managed = managedBinaryPath(executable)
  if (managed && (await fsp.access(managed).then(() => true, () => false))) {
    // 受管件也过探针（批次5）：装了但跑不起来（peer 缺失/损坏）不该被当成可启动。
    const probe = await probeBinary(managed)
    if (!probe.runnable) {
      logger.warn(`code-mate: managed "${executable}" at ${managed} failed the --version probe`)
    }
    logger.info(`code-mate: "${executable}" resolved to managed ${managed}`)
    return { source: 'managed', path: managed, ...(probe.version ? { version: probe.version } : {}), runnable: probe.runnable }
  }
  const found = await probeSystemPath(executable)
  if (!found) {
    logger.info(`code-mate: "${executable}" not found on PATH`)
    return null
  }
  // where.exe 在 Win 上可能返回带引号或多行结果；取首行并去引号。
  const normalized = found.replace(/^"(.*)"$/, '$1')
  const systemPath = path.isAbsolute(normalized) ? normalized : found
  const probe = await probeBinary(systemPath)
  logger.info(`code-mate: "${executable}" resolved to ${systemPath}`, {
    ...(probe.version ? { version: probe.version } : {}),
    runnable: probe.runnable
  })
  return { source: 'system', path: systemPath, ...(probe.version ? { version: probe.version } : {}), runnable: probe.runnable }
}
