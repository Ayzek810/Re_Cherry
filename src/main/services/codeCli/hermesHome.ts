// fork 移植自 cherry-studio v2 src/main/services/codeCli/hermesHome.ts（2026-09-24，v0.3.4-1）。
// fork 缝：V2 默认落 pathRegistry('external.hermes.default_home')；fork 钉进 CodeMate 子树
// （随数据目录移动、卸载=删子树，portable 语义）。显式 HERMES_HOME 覆盖仍尊重（V2 语义）。
// AbsoluteFilePath 品牌类型未移植，退化为 string。

import path from 'node:path'

import { isWin } from '@main/constant'
import { getRawShellEnv } from '@main/utils/shellEnv'

import { hermesHome } from '../deepSeekHarness/paths'

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  if (!isWin) return env[name]?.trim() ?? ''
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? (env[key]?.trim() ?? '') : ''
}

/** Resolve the Hermes home the way Hermes itself does: HERMES_HOME override, else the platform default. */
export function resolveHermesHome(env: NodeJS.ProcessEnv): string {
  const override = readEnv(env, 'HERMES_HOME')
  if (override) return path.resolve(override)
  return hermesHome()
}

let pinnedHome: Promise<string> | null = null

/**
 * Session-pinned Hermes home. Config reads/writes and the Dashboard process must
 * all see one value, even if a shell-env refresh changes HERMES_HOME mid-session.
 */
export function getHermesHome(): Promise<string> {
  pinnedHome ??= getRawShellEnv().then(resolveHermesHome)
  return pinnedHome
}
