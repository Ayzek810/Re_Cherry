// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/clear.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点一处：V2 `ipcApi.request('code_cli.write_config', …)` → fork `window.api.codeCli.writeConfig`
//（直连通道；返回 {success, message?} 形状与 V2 operationResult 一致，收窄见缝注）。

import { isFileConfiguredCli } from '@shared/utils/cliConfig'

import { getAdapter } from './adapters'

export interface ClearCliConfigArgs {
  /** CLI tool whose config file should be scrubbed. */
  cliTool: string
}

/** Remove every Cherry-managed key from a CLI tool's config file, leaving user-owned keys intact. */
export async function clearCliConfig(args: ClearCliConfigArgs): Promise<void> {
  const { cliTool } = args
  if (!isFileConfiguredCli(cliTool)) return
  const files = (await getAdapter(cliTool)?.buildClearFiles()) ?? []
  if (!files.length) return
  // fork 缝：V2 为 `await ipcApi.request('code_cli.write_config', { cliTool, files })`。
  const result = (await window.api.codeCli.writeConfig({ cliTool, files })) as {
    success: boolean
    message?: string
  }
  if (!result.success) {
    throw new Error(result.message)
  }
}
