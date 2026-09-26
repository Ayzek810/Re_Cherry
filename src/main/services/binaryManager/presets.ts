// fork 缝（原创）：V2 为 mise 驱动，本件为 portable 等价实现——fork 安装器（binaryManager）
// 只消费获取事实（id/executable/packageName/install/requiredPeer），mise 命令面字段
// （miseTool/skillNamespace/miseNpmShellOut 等）不进入本视图。数据不复制，单一事实源在
// @shared/data/presets/codeCliTools（V2 同名文件的 fork 裁剪版）；设计来源：V2 BinaryManager
// + 勘查报告结论（docs/v0.3.4_doc.md）。

import { CODE_CLI_TOOL_PRESETS, type CodeCliToolPreset } from '@shared/data/presets/codeCliTools'

/** fork 安装器消费的字段子集（对 shared CodeCliToolPreset 的只读收窄视图，零数据复制）。 */
export type BinaryToolPreset = Pick<
  CodeCliToolPreset,
  'id' | 'executable' | 'packageName' | 'install' | 'requiredPeer'
>

/** shared 预设的安装器视图（同一数组对象，仅类型收窄）。 */
export const BINARY_TOOL_PRESETS: readonly BinaryToolPreset[] = CODE_CLI_TOOL_PRESETS

/** 受管安装器操作的工具名（= executable，即 tools/<name> 目录名）。 */
export type BinaryToolName = (typeof CODE_CLI_TOOL_PRESETS)[number]['executable']

/** 安装器可操作的白名单（IPC 入参校验用）。 */
export const BINARY_TOOL_NAMES: readonly BinaryToolName[] = BINARY_TOOL_PRESETS.map((preset) => preset.executable)

export function isBinaryToolName(value: unknown): value is BinaryToolName {
  return typeof value === 'string' && (BINARY_TOOL_NAMES as readonly string[]).includes(value)
}
