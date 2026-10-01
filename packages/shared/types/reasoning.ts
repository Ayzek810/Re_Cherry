/**
 * 思考协议修正的跨进程契约（渲染层构造、内核消费）。
 *
 * 为什么需要单一来源：渲染进程写错一个成员名不会报错，只会在运行期静默丢弃修正
 * （思考档位失效，或"关"关不掉）。此前两侧各抄一份，靠注释约束对齐——注释不是保证。
 * 现在两侧引用同一份声明，任一侧新增或改名都会在另一侧变成编译错误。
 */

/** 思考协议格式。 */
export type ThinkingFormat =
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'together'
  | 'zai'
  | 'qwen'
  | 'chat-template'
  | 'qwen-chat-template'
  | 'string-thinking'
  | 'ant-ling'

/** 可透传给 pi-ai 的 per-model 兼容覆盖；仅出现的键会被 pi-ai 采用。 */
export interface ProviderReasoningCompat {
  thinkingFormat?: ThinkingFormat
  supportsReasoningEffort?: boolean
  requiresReasoningContentOnAssistantMessages?: boolean
  /** 该网关是否接受 role: "developer"（OpenAI 新式系统角色）；不支持须显式关掉。 */
  supportsDeveloperRole?: boolean
}
