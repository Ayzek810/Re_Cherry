import type { ReactNode } from 'react'

import type { Model } from '../../cliConfig/providerView'
import { CodeCli } from '@shared/types/codeCli'

import { DeepSeekHarnessConfigFields } from './tools/DeepSeekHarnessConfigFields'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/toolFieldRenderer.tsx
//（2026-09-24，v0.3.4-1 批次4b）。fork 缝（注册表收窄）：V2 的六工具字段表（claude/codex/gemini/
// qwen/kimi/opencode）不搬——对应工具未移植；保留工具 hermes 无独立字段表（文件配置型，走
// CliConfigEditor 的 yaml/env 原文编辑器），dsh 臂逐字保留。renderClaudeDetailedModelSlot 随
// Claude detailed-models 臂删除（claudeModels.ts 未移植，见 4a useConfigMetadata 缝④）。

interface ToolFieldRenderOptions {
  cliTool: CodeCli
  config: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  section: 'basic' | 'advanced'
  providerId: string
  modelFilter: (model: Model) => boolean
}

export function renderToolFields({
  cliTool,
  config,
  onChange,
  section,
  providerId,
  modelFilter
}: ToolFieldRenderOptions): ReactNode {
  void providerId
  void modelFilter
  switch (cliTool) {
    case CodeCli.DEEPSEEK_HARNESS:
      if (section === 'advanced') return null
      return <DeepSeekHarnessConfigFields config={config} onChange={onChange} section={section} />
    default:
      return null
  }
}
