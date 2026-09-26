// fork 移植自 cherry-studio v2 src/shared/data/presets/codeCliTools.ts（2026-09-24，v0.3.4-1）。
// 改动仅两处裁剪，均已标 `// fork 缝`。路径映射注：V2 的 src/shared/data/presets/ 在本仓
// 镜像为 packages/shared/data/presets/（保持 @shared/data/presets/codeCliTools import 原样）。

import { CodeCli } from '@shared/types/codeCli'

/** Canonical acquisition facts for a Code CLI tool. */
export interface CodeCliToolPreset {
  id: CodeCli
  executable: string
  skillFolderName: string
  skillNamespace: `code-cli:${CodeCli}`
  packageName: string
  install: 'registry' | 'npm' | 'pipx' | 'aqua'
  miseTool: string
  misePrerelease?: boolean
  /** Use npm CLI when mise's embedded installer cannot install this package. */
  miseNpmShellOut?: boolean
  /** Exact npm packages whose lifecycle scripts mise may run during installation. */
  npmAllowBuilds?: readonly string[]
  /**
   * A peer this tool needs at runtime but whose absence an install still reports
   * as success, named as `peer` resolved from `host`'s own entry point.
   */
  requiredPeer?: { host: string; peer: string }
}

type CodeCliToolDefinition = Omit<CodeCliToolPreset, 'miseTool' | 'skillNamespace'> & {
  /** pipx extras required to install this tool's built-in capabilities. */
  pipxExtras?: readonly string[]
}

function defineCodeCliTool({ pipxExtras, ...definition }: CodeCliToolDefinition): Readonly<CodeCliToolPreset> {
  const packageTool =
    definition.install === 'registry' ? definition.executable : `${definition.install}:${definition.packageName}`
  const extras = definition.install === 'pipx' && pipxExtras?.length ? pipxExtras.join(',') : ''
  return Object.freeze({
    ...definition,
    skillNamespace: `code-cli:${definition.id}` as const,
    miseTool: extras ? `${packageTool}[extras=${extras}]` : packageTool
  })
}

/**
 * Single source of truth for executable names, npm packages, and mise install
 * specs used by both main and renderer processes.
 */
// fork 缝：预设表裁到 2 项（原 14 项）。mise* 字段逐字保留但 fork 安装器不消费——
// fork 的 portable 安装器把 install:'npm' 映射为 npm --prefix、install:'pipx' 映射为
// uv venv + uv pip install（见 main/services/binaryManager），mise 命令面被替换。
export const CODE_CLI_TOOL_PRESETS = Object.freeze([
  defineCodeCliTool({
    id: CodeCli.DEEPSEEK_HARNESS,
    executable: 'dsh',
    skillFolderName: 'code-mate-deepseek-harness',
    packageName: '@deepseek-ai/dsh',
    install: 'npm',
    misePrerelease: true,
    // mise 2026.7.14 aube exceeds its 16-pass fixed-point limit on DSH's recursive peer graph.
    miseNpmShellOut: true,
    // dsh-scope is nowhere a real dependency, only a transitive peer, so an install
    // reports success without it (#19313).
    requiredPeer: { host: '@deepseek-ai/dsh-agent-loop', peer: '@deepseek-ai/dsh-scope' }
  }),
  defineCodeCliTool({
    id: CodeCli.HERMES,
    executable: 'hermes',
    skillFolderName: 'code-mate-hermes',
    packageName: 'hermes-agent',
    install: 'pipx',
    pipxExtras: ['web']
  })
] as const satisfies readonly Readonly<CodeCliToolPreset>[])

export const CODE_CLI_TOOL_PRESET_MAP = Object.freeze(
  Object.fromEntries(CODE_CLI_TOOL_PRESETS.map((preset) => [preset.id, preset])) as Record<
    CodeCli,
    Readonly<CodeCliToolPreset>
  >
)

export const CODE_CLI_TOOL_PRESET_BY_EXECUTABLE = Object.freeze(
  Object.fromEntries(CODE_CLI_TOOL_PRESETS.map((preset) => [preset.executable, preset])) as Readonly<
    Record<string, (typeof CODE_CLI_TOOL_PRESETS)[number] | undefined>
  >
)
