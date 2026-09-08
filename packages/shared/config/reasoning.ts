/**
 * 思考强度档位词汇（与 dsh-llm / pi-ai 的 ReasoningEffortId 取值一致，按强度升序）。
 * 渲染进程把 Cherry 的思考档位（none/minimal/low/medium/high/xhigh/auto/default）映射到这些内核档位后，
 * 再经由 dsh IPC 透传给内核；缺省（undefined/空串）表示不显式请求，交由 provider 决定。
 */
export const KERNEL_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type KernelReasoningLevel = (typeof KERNEL_REASONING_LEVELS)[number]

/** Cherry UI 侧思考档位（assistant.settings.reasoning_effort 取值）。 */
export type CherryThinkingOption = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | 'default'
