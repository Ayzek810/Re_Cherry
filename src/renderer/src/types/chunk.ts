/**
 * Chunk 协议文件。
 *
 * 原文件还包含 `ChunkType` 枚举、39 个 `XxxChunk` 接口与 `Chunk` 联合类型——那是
 * v1 渲染层流式管线的第二套 chunk 词汇，全仓已无消费者（内核 `StreamChunk` 是唯一
 * 权威投影结构）。按 六种消费形式复核后在 中删除。
 *
 * 说明（复核补记）：原先引用本 `ProviderMetadata` 的两个模块
 *（`services/StreamProcessingService.ts`、`services/messageStreaming/callbacks/textCallbacks.ts`）
 * 已随死树删除一并移除，`types/newMessage.ts:2` 取的是 `ai` 包的同名类型。
 * 故本接口当前也**没有活消费方**；只因它是纯类型声明、且 `types/index.ts` 未 `export *` 本文件
 *（无公开导出面），保留它不会扩大任何接口面，删除留待下一次导出面清理时一并处理。
 */

/**
 * Provider metadata type for passing provider-specific data through chunks
 * Currently used for passing thoughtSignature from Gemini through the chunk pipeline
 */
export interface ProviderMetadata {
  google?: {
    thoughtSignature?: string
    [key: string]: unknown
  }
  [provider: string]: unknown
}
