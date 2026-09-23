// fork 缝：V2 `variants/shared/composerTokens.ts` 的 file 分支。
// `ComposerAttachment` 是 fork 缺的替身形状（V2 类型在 `@renderer/utils/message/composerAttachment`）：
// 绘画里附件就是 fork 的 `FileMetadata`（页面自持参考图托盘），故本类型 = FileMetadata 的
// 只读投影，不引 fork 的 types 模块以免与 V2 的 `payload: file` 语义脱钩。
import type { ComposerDraftToken } from '@renderer/components/composer/tokens'
import type { FileMetadata } from '@renderer/types'

export type ComposerAttachment = FileMetadata

/** V2 `composerFileTokenIdFromSourceId` 的 fork 替身：附件 id 即源的稳定标识。 */
export const composerFileTokenIdFromSourceId = (sourceId: string) => `file:${sourceId}`

/** V2 `composerTokens.ts:11-17` `composerFileTokenId`：sourceId 缺失即抛错（保持 V2 契约）。 */
export const composerFileTokenId = (file: Pick<ComposerAttachment, 'id'>) => {
  const sourceId = file.id
  if (!sourceId) {
    throw new Error('fileTokenSourceId is required to create a composer file token id')
  }
  return composerFileTokenIdFromSourceId(sourceId)
}

/**
 * fork 缝（P0-B/P0-C）：把一批新附件并入草稿——按 id 去重、保持先后顺序。"+"选图与提示框
 * 粘贴共用这一条规范化路径（V2 两处各自 `[...c, ...incoming]`，无去重）。数量上限不在此处
 * 判定：上限闸统一在物化时走既有 `INPUT_IMAGE_LIMIT_EXCEEDED`（usePaintingComposerInputFiles）。
 */
export function mergeComposerAttachments(
  prev: ComposerAttachment[],
  incoming: ComposerAttachment[]
): ComposerAttachment[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map((file) => file.id))
  return [...prev, ...incoming.filter((file) => !seen.has(file.id))]
}

/** V2 `composerTokens.ts:21-28` `fileToComposerToken`，逐字搬运（仅 id 源换成 fork 附件 id）。 */
export function fileToComposerToken(file: ComposerAttachment): ComposerDraftToken {
  return {
    id: composerFileTokenId(file),
    kind: 'file',
    label: file.origin_name || file.name,
    payload: file
  }
}
