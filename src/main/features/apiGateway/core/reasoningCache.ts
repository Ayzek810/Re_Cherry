/**
 * Reasoning Cache Service
 *
 * Manages reasoning-related caching for AI providers that support thinking/reasoning modes.
 * This includes Google Gemini's thought signatures and OpenRouter's reasoning details.
 */

// fork 缝：V2 的 CacheService 依赖 @application 容器（CacheService.shared，
// fork 不移植 V2 容器体系）→ 进程内 Map 等价实现。网关推理签名缓存是进程级
// 瞬态（Gemini 多轮思考签名 / OpenRouter reasoning_details，随请求写入、随
// 下一轮回放），无跨窗口需求。TTL 语义按 V2 原文保留：写入记 expireAt，
// 读取时惰性判定过期并删除（与 V2 CacheService.getInternal 的读路径同型；
// V2 另有周期 GC 扫描，此处瞬态量小、惰性清理已等价，不引入定时器）。

import type { ReasoningDetailUnion } from './openrouter'

/**
 * Interface for reasoning cache
 */
export interface IReasoningCache<T> {
  set(key: string, value: T): void
  get(key: string): T | undefined
}

/**
 * Cache duration: 30 minutes
 * Reasoning data is typically only needed within a short conversation context
 */
const REASONING_CACHE_DURATION = 30 * 60 * 1000

interface CacheEntry<T> {
  value: T
  expireAt?: number
}

function createReasoningCache<T>(prefix: string): IReasoningCache<T> {
  const store = new Map<string, CacheEntry<T>>()
  return {
    set: (key, value) => store.set(`${prefix}:${key}`, { value, expireAt: Date.now() + REASONING_CACHE_DURATION }),
    get: (key) => {
      const entry = store.get(`${prefix}:${key}`)
      if (!entry) return undefined
      if (entry.expireAt && Date.now() > entry.expireAt) {
        store.delete(`${prefix}:${key}`)
        return undefined
      }
      return entry.value
    }
  }
}

/**
 * Google Gemini reasoning cache
 *
 * Stores thought signatures for Gemini 3 models to handle multi-turn conversations
 * where the model needs to maintain thinking context across tool calls.
 */
export const googleReasoningCache: IReasoningCache<string> = createReasoningCache('google-reasoning')

/**
 * OpenRouter reasoning cache
 *
 * Stores reasoning details from OpenRouter responses to preserve thinking tokens
 * and reasoning metadata across the conversation flow.
 */
export const openRouterReasoningCache: IReasoningCache<ReasoningDetailUnion[]> = createReasoningCache(
  'openrouter-reasoning'
)
