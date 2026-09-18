/**
 * 轻量 LLM 服务的 IPC 契约（主进程 kernel/lightLlm ↔ 渲染进程 services/lightLlm）。
 *
 * "轻量"= 无会话、无 agent、无工具：直接 ctx.llm.stream 一次往返，用完即弃。
 * 快捷助手 / 话题命名(快速模型) / 错误诊断 / 健康检查 / 未来翻译·知识库嵌入重排·
 * 搜索编排等一切"功能要用一下 AI"的场景统一走这条通道，禁止各功能自配内核旁路。
 *
 * 与重路径(topicTree.send → agent loop → session 落库)的唯一共享面：provider 路由
 * 与思考协议 compat（syncProvidersToKernel 同步的那份），因此轻量调用自动继承
 * 开发者角色/enable_thinking 等全部网关修正。
 */

/** 轻量消息：纯文本、user/assistant 两种角色（工具轮不进入轻量面）。 */
export interface LightLlmMessage {
  role: 'user' | 'assistant'
  text: string
}

/** 轻量调用请求（一次性与流式共用同一形状）。 */
export interface LightLlmCall {
  provider: string
  model: string
  /** 系统提示（空串/undefined 都视为无）。 */
  system?: string
  messages: LightLlmMessage[]
  maxTokens?: number
  /**
   * 显式思考档位（内核档位拼写：off/low/medium/high/max）。
   * 缺省走服务默认：一次性调用解析为 off（工具型生成不需要思考；off 不被模型
   * 支持时自动弱化为"不发参数"，见 pickReasoningLevel），流式调用保持模型默认。
   */
  reasoningEffort?: string
  /** 调用方标签（事件溯源/日志用，如 cherry-topic-naming）；缺省回退 cherry-light。 */
  source?: string
}

/** 轻量调用的用量回执。 */
export interface LightLlmUsage {
  inputTokens: number
  outputTokens: number
}

/** 流式事件（内核 → 渲染进程，按 requestId 配对）。 */
export type LightLlmStreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
