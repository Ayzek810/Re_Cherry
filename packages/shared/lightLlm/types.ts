/**
 * 轻量 LLM 服务的 IPC 契约（主进程 kernel/lightLlm ↔ 渲染进程 services/lightLlm）。
 *
 * "轻量"= 无会话、无 agent、无工具：chat 走 ctx.llm.stream 一次往返，用完即弃；
 * embed/rerank/image 为同面的非 chat 模态端点（OpenAI 兼容平面直连，provider 路由
 * 解析与 chat 共用一套底座）。
 * 快捷助手 / 话题命名(快速模型) / 错误诊断 / 健康检查 / 翻译 / 知识库嵌入重排 /
 * 搜索编排 / 绘画 / 聊天生图工具等一切"功能要用一下 AI"的场景统一走这条通道，
 * 禁止各功能自配内核旁路。
 *
 * 与重路径(topicTree.send → agent loop → session 落库)的共享面：provider 路由
 * 与思考协议 compat（syncProvidersToKernel 同步的那份），因此轻量 chat 调用自动
 * 继承开发者角色/enable_thinking 等全部网关修正。
 */

/** 轻量消息：纯文本、user/assistant 两种角色（工具轮不进入轻量面）。 */
export interface LightLlmMessage {
  role: 'user' | 'assistant'
  text: string
}

/** 随调用上行的图片（base64；mediaType 校验在主进程准入时执行）。 */
export interface LightLlmImage {
  /**
   * 声明的媒体类型，准入时按解码字节核验。封闭联合与内核 wire 契约同款
   * （Dsh_TopicSend images 载荷同形状）。
   */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** 图片字节的 base64 编码（不带 data: 前缀）。 */
  data: string
  /** 可选显示名；永不解释为路径。 */
  name?: string
}

/** 轻量调用请求（一次性与流式共用同一形状）。 */
export interface LightLlmCall {
  provider: string
  model: string
  /** 系统提示（空串/undefined 都视为无）。 */
  system?: string
  messages: LightLlmMessage[]
  /**
   * 随 user 首条消息上行的图片（快捷助手视觉通路）。准入失败整轮拒绝；
   * 非视觉模型由 wire 自动降级为占位文本（内核既有机制）。
   */
  images?: LightLlmImage[]
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

// ---- 图像模态（绘画页 / generate_image 工具的执行缝；OpenAI 兼容平面直连） ----

/** 图像生成请求（参数透传族可缺省；异步 poll 型厂商不支持，命中明错）。 */
export interface LightImageGenerateCall {
  provider: string
  model: string
  prompt: string
  /** 输出尺寸（如 "1024x1024"；原样透传 size）。 */
  imageSize: string
  /** 生成张数。 */
  batchSize: number
  negativePrompt?: string
  seed?: string
  numInferenceSteps?: number
  guidanceScale?: number
  quality?: string
  /** 渲染层经 Dsh_LightImageAbort 取消时用；主进程直调可传 AbortSignal。 */
  requestId?: string
}

/** 图像编辑请求（逐张 multipart /images/edits）。 */
export interface LightImageEditCall {
  provider: string
  model: string
  prompt: string
  /** 输入图（data URL 或裸 base64）。 */
  inputImages: string[]
  imageSize?: string
  requestId?: string
}

/** 图像模态结果：base64（data URL 形式）或远程 url，调用方自行落盘。 */
export interface LightImageResult {
  type: 'url' | 'base64'
  images: string[]
}
