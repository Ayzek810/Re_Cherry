// fork 缝：V2 `components/composer/tokens.ts` 的类型层。V2 的 kind 取值来自
// `@renderer/utils/composerTokenPolicy` 的能力表（fork 无该模块，也无任何 token
// 消费者：绘画只造 `file` token），故此处只保留 V2 接口形状 + 实际用到的 kind。
/** V2 `COMPOSER_TOKEN_KINDS` 中绘画用到的两个取值。 */
export type ComposerDraftTokenKind = 'file' | 'reference'

/** V2 tokens.ts:18-26 `ComposerDraftToken`，逐字保留字段形状。 */
export interface ComposerDraftToken {
  id: string
  kind: ComposerDraftTokenKind
  label: string
  icon?: string
  description?: string
  promptText?: string
  payload?: unknown
}

/** V2 tokens.ts:31-34 `ComposerSerializedToken`。 */
export interface ComposerSerializedToken extends ComposerDraftToken {
  index: number
  textOffset: number
}

/** V2 tokens.ts:36-39 `ComposerSerializedDraft`。 */
export interface ComposerSerializedDraft {
  text: string
  tokens: ComposerSerializedToken[]
}
