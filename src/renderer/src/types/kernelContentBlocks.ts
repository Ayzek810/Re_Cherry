/**
 * fork 内容块扩展（v0.3.2 附件修复）：'document' 引用块经 dsh-llm 公开的
 * merge-extensible 扩展点（ContentBlockMap，types.d.ts 明文契约："switch on
 * `type` and fall through unknowns"）并入内核内容块词表。
 *
 * 为什么进内核日志：会话日志是唯一权威（不变量2）——"哪条消息挂了哪些文档"
 * 是会话状态，必须可由折叠恢复。与图片附件同构（日志存引用，不在渲染层旁路
 * 建第二真相源）；区别是文档字节留在磁盘原路径（read_document 按路径直读），
 * 引用块只存元数据。LLM 请求组装对未知块 default 跳过（dsh-llm-pi-ai
 * userContent/foreignAssistant 实测）——文档经 read_document 工具按需进上下文，
 * 不塞请求。渲染层 FILE 块重建见 kernelChat projectEventsToMessages。
 *
 * 位置：本文件须同时进 node/web 两个编译程序（发送侧窄化在主进程，恢复折叠
 * 窄化在渲染层）——tsconfig.node 的 src/renderer/src/types/* 与 tsconfig.web 的
 * src/renderer/src/** 恰好交集于此。
 */
import '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    /** 文档附件引用块（用户消息专用；文件字节留在磁盘原路径）。 */
    document: {
      type: 'document'
      /** 展示名（origin_name）——模型按它引用，恢复折叠据此重建 FILE 块。 */
      name: string
      /** 绝对路径。 */
      path: string
      /** 扩展名（含点，如 ".doc"）。 */
      ext?: string
    }
  }
}
