/**
 * 知识库嵌入客户端：openai-compatible /v1/embeddings 与 ollama /api/embeddings 两路。
 *
 * v0.3.3 批次2 归位：实现整体迁至 kernel/lightLlmModalities.ts（轻量 AI 服务面
 * embed 端点，与 chat/rerank/image 共用一套 provider 路由底座）；本文件退为薄委托
 * ——KnowledgeService 的既有引用面不变，路由快照同步也仍经本类转发
 * （Dsh_SyncProviders 同一载荷；密钥不回渲染层、不进会话日志，fork 偏离不变）。
 */
import { lightEmbed, setLightLlmProviderRoutes, type LightEmbedRef } from '@main/kernel/lightLlmModalities'

export interface EmbeddingModelRef {
  providerId: string
  modelId: string
  dimensions?: number
}

export class EmbeddingClient {
  /** 内核 provider 路由快照（Dsh_SyncProviders 载荷）整体投影。 */
  setProviders(providers: Array<{ id?: string; apiHost?: string; apiKey?: string }>): void {
    setLightLlmProviderRoutes(providers)
  }

  /** 批量嵌入（返回与输入同序的归一化向量）。任一批失败整批抛错（由调用方重试）。 */
  async embed(ref: EmbeddingModelRef, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    return lightEmbed(ref as LightEmbedRef, inputs, signal)
  }
}
