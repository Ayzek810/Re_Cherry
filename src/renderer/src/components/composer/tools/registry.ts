// fork 缝：V2 `components/composer/tools/registry.ts` 的 painting 作用域条目。
// V2 的 scope 键空间是 `TopicType | 'quick-assistant' | 'painting'`（fork 无 topic 类型域），
// 缝件只需 painting + 一个兜底作用域，故 scope 收敛为字符串字面量。
export type ComposerToolScope = 'painting'

export interface ComposerToolScopeConfig {
  enableQuickPanel?: boolean
  enableDragDrop?: boolean
}

/** V2 registry.ts:24-27 painting 条目，逐字取值。 */
const composerToolConfigRegistry: Record<ComposerToolScope, ComposerToolScopeConfig> = {
  painting: {
    enableQuickPanel: true,
    enableDragDrop: true
  }
}

export const getComposerToolConfig = (scope: ComposerToolScope): ComposerToolScopeConfig => {
  return composerToolConfigRegistry[scope] ?? composerToolConfigRegistry.painting
}
