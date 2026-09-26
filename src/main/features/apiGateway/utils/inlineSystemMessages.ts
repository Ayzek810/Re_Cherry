/**
 * The Claude Agent SDK emits harness updates (agent/skill catalogs, deferred-tool
 * notices, "MCP servers are still connecting") as `role: 'system'` messages inside
 * `messages`, and `AnthropicMessageConverter` keeps them where the client put them.
 * That position is what makes the prompt prefix stable: a new update appends at the
 * tail, so everything before it still hits the provider's prefix cache.
 *
 * Not every target accepts that shape, so `SYSTEM_IN_PLACE_ENDPOINTS` allowlists the
 * ones whose converter was verified to keep a non-leading system message rather than
 * reject it.
 *
 * For the rest there are two outcomes. A client that negotiated
 * `mid-conversation-system-2026-04-07` gets a 400 naming the beta and downgrades itself
 * to `<system-reminder>` blocks inside user turns — which keeps *its* prefix stable, so
 * nothing is lost. A client that did not negotiate it has no downgrade path, so its
 * messages are folded instead: correct output, at the cost of the prefix cache.
 */
// fork 缝：V2 的 EndpointType 取自 @shared/data/types/model（@cherrystudio/
// provider-registry 词表），CherryUIMessage 取自 @shared/data/types/message。
// fork 引擎（pi-ai 路由）的 endpoint 词表即路由协议 id（PROTOCOL_BY_TYPE 的值），
// 白名单值与 V2 等价：anthropic-messages / openai-responses 两类目标保留中置
// system（其余 hoist）。CherryUIMessage 用 adapters/interfaces 的最小结构替身。

import type { CherryUIMessage } from '../adapters/interfaces'

/** Endpoint type = fork 内核的 pi-ai 路由协议 id（见 engine/llmEngine.resolveEndpointType）。 */
type EndpointType = string

/**
 * Verified against the installed SDKs in V2:
 * - `@ai-sdk/anthropic` pushes `{ role: 'system' }` mid-conversation (beta header) —
 *   the fork's `anthropic-messages` pi-ai route forwards mid-list system messages
 *   (downgraded to user text by the adapter), never a hard reject.
 * - `@ai-sdk/openai` 3.0.53 pushes it on the responses path — the fork's
 *   `openai-responses` route behaves the same way.
 *
 * Deliberately excluded (same reasons as V2): Google's converter throws on
 * mid-conversation system, and the chat-completions/ollama style targets answer
 * `System message must be at the beginning` with a 400 or drop the message
 * silently. The gateway resolves one endpoint type for all of them and has no
 * per-backend capability signal, so neither can stay in place.
 */
const SYSTEM_IN_PLACE_ENDPOINTS: ReadonlySet<EndpointType> = new Set(['anthropic-messages', 'openai-responses'])

/** Whether `endpointType` keeps a non-leading system message in place instead of rejecting it. */
export function keepsSystemMessagesInPlace(endpointType: EndpointType | undefined): boolean {
  return endpointType !== undefined && SYSTEM_IN_PLACE_ENDPOINTS.has(endpointType)
}

const systemText = (message: CherryUIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .filter(Boolean)
    .join('\n\n')

/** Whether any `role: 'system'` message sits after the conversation has started. */
export function hasNonLeadingSystemMessage(messages: CherryUIMessage[]): boolean {
  const firstNonSystem = messages.findIndex((message) => message.role !== 'system')
  return firstNonSystem !== -1 && messages.slice(firstNonSystem).some((message) => message.role === 'system')
}

/**
 * Merge every `role: 'system'` message into one leading message, preserving order.
 * Returns the input unchanged when at most a leading system message is present.
 */
export function hoistSystemMessages(messages: CherryUIMessage[]): CherryUIMessage[] {
  if (!hasNonLeadingSystemMessage(messages)) return messages

  const system = messages.filter((message) => message.role === 'system')
  const rest = messages.filter((message) => message.role !== 'system')
  const text = system.map(systemText).filter(Boolean).join('\n\n')
  if (!text) return rest

  return [{ ...system[0], role: 'system', parts: [{ type: 'text', text }] }, ...rest]
}

/** The beta a client sets to declare it can send — and downgrade from — inline system messages. */
export const MID_CONVERSATION_SYSTEM_BETA = 'mid-conversation-system-2026-04-07'

function negotiatedMidConversationSystem(requestHeaders: Headers | undefined): boolean {
  const betas = requestHeaders?.get('anthropic-beta')
  return (
    betas !== null && betas !== undefined && betas.split(',').some((b) => b.trim() === MID_CONVERSATION_SYSTEM_BETA)
  )
}

/**
 * The Agent SDK retries without the beta when a 400's message names it, then sticky-disables
 * it for the session. Its matcher reads the message text, so the beta name and the literal
 * `anthropic-beta` must both survive into the error envelope verbatim.
 */
function midConversationSystemUnsupported(): Error & { status: number } {
  const error = new Error(
    `Unexpected role "system" in input message role list: ` +
      `anthropic-beta ${MID_CONVERSATION_SYSTEM_BETA} is not supported for this target model.`
  ) as Error & { status: number }
  error.status = 400
  return error
}

/**
 * Place inline system messages for the resolved target.
 *
 * @throws a 400 naming the beta when the client negotiated it, so it downgrades itself.
 */
export function positionInlineSystemMessages(
  messages: CherryUIMessage[],
  endpointType: EndpointType | undefined,
  requestHeaders: Headers | undefined
): CherryUIMessage[] {
  if (keepsSystemMessagesInPlace(endpointType)) return messages
  if (!hasNonLeadingSystemMessage(messages)) return messages
  if (negotiatedMidConversationSystem(requestHeaders)) throw midConversationSystemUnsupported()
  return hoistSystemMessages(messages)
}
