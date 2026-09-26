// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/draftUpdater.ts（2026-09-24，v0.3.4-1 批次4a）。
// 逐字（hermes 依赖闭包内全量保留）。

import { getAdapter, sanitizeCliConfigBlob } from './adapters'
import { parseJsonOrThrow, renderJsonFile } from './file'
import { extractConnectionFromCliConfigDraft } from './parser'
import type { CliConfigFileDraft } from './types'
import { asRecord } from './values'

export function formatCliConfigDraftFile(file: CliConfigFileDraft): CliConfigFileDraft {
  if (file.language !== 'json') return file
  return { ...file, content: renderJsonFile(parseJsonOrThrow(file.content)) }
}

export function updateCliConfigDraftConfig(
  cliTool: string,
  files: CliConfigFileDraft[],
  configBlob: Record<string, unknown>
): CliConfigFileDraft[] {
  const connection = extractConnectionFromCliConfigDraft(cliTool, files)
  const blob = sanitizeCliConfigBlob(cliTool, asRecord(configBlob))
  if (!connection) return files
  return getAdapter(cliTool)?.updateDraftConfig(files, connection, blob) ?? files
}
