// fork 移植自 cherry-studio v2 src/shared/utils/cliConfig.ts（2026-09-24，v0.3.4-1）。
// 改动仅一处裁剪（目标/文件规格表裁到 hermes 两 target），已标 `// fork 缝`。

import { CodeCli } from '@shared/types/codeCli'

/**
 * The on-disk config-file surface of the file-configured Code CLIs.
 * Cross-process single source of truth: the renderer builds drafts and labels
 * from it; main validates and resolves `code_cli.write_config` targets against
 * it — the target-id enum below is the write allow-list, so the renderer never
 * sends a path over IPC.
 */

// fork 缝：target 白名单裁到 hermes 两项（原 13 项）。
export const CLI_CONFIG_TARGET_IDS = ['hermes-config', 'hermes-env'] as const

export type CliConfigTarget = (typeof CLI_CONFIG_TARGET_IDS)[number]

export type CliConfigLanguage = 'json' | 'toml' | 'dotenv' | 'yaml'

/** One transactional file mutation sent over `code_cli.write_config`. */
export type CliConfigWriteFile = { target: CliConfigTarget; content: string; delete?: never }

// fork 缝：hermes 之外的家目录路径常量随裁剪移除。
// Unlike the `~/…` paths in V2, these are relative to the runtime-resolved Hermes
// home (HERMES_HOME or platform default) — see `pathBase: 'hermes-home'` below.
export const HERMES_CONFIG_PATH = 'config.yaml'
export const HERMES_ENV_PATH = '.env'

// fork 缝：文件规格表裁到 hermes 两项（原 13 项）。
export const CLI_CONFIG_FILE_SPECS: Record<
  CliConfigTarget,
  { label: string; path: string; language: CliConfigLanguage; pathBase?: 'hermes-home' }
> = {
  'hermes-config': {
    label: 'Hermes config.yaml',
    pathBase: 'hermes-home',
    path: HERMES_CONFIG_PATH,
    language: 'yaml'
  },
  'hermes-env': { label: 'Hermes .env', pathBase: 'hermes-home', path: HERMES_ENV_PATH, language: 'dotenv' }
}

/** The file-based CLI tools, as a tuple so IPC schemas can `z.enum` it. */
// fork 缝：file-configured 工具裁到 hermes 一项（原 9 项）。
export const FILE_CONFIGURED_CLI_TOOL_IDS = [CodeCli.HERMES] as const

export type FileConfiguredCli = (typeof FILE_CONFIGURED_CLI_TOOL_IDS)[number]

/**
 * The config files each file-based CLI tool owns. Single source of truth for
 * both "which tools write config files" (`FILE_CONFIGURED_CLI_TOOLS`) and "which
 * files" (`getCliConfigTargets`) — the two used to be separate lists that had to
 * be kept in sync by hand.
 */
const CLI_CONFIG_TARGETS: Record<FileConfiguredCli, readonly CliConfigTarget[]> = {
  [CodeCli.HERMES]: ['hermes-config', 'hermes-env']
}

/** CLI tools that write on-disk config files (the ones with targets above). */
export const FILE_CONFIGURED_CLI_TOOLS: ReadonlySet<string> = new Set(FILE_CONFIGURED_CLI_TOOL_IDS)

export function isFileConfiguredCli(cliTool: string): cliTool is FileConfiguredCli {
  return FILE_CONFIGURED_CLI_TOOLS.has(cliTool)
}

export function getCliConfigTargets(cliTool: string): readonly CliConfigTarget[] {
  return isFileConfiguredCli(cliTool) ? CLI_CONFIG_TARGETS[cliTool] : []
}
