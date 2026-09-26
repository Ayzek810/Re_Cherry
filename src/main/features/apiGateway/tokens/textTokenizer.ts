// fork 缝：V2 的 @main/ai/tokens/textTokenizer（tokenx 启发式 + 懒加载 gpt-tokenizer
// BPE）。fork 只保留 tokenx 启发式——BPE 精确档只被"转换级 footprint 估算"消费，
// 该估算器依赖 @main/ai 数据层未随 fork 移植（见 estimateAnthropicRequestTokens 的缝注）。

import { estimateTokenCount } from 'tokenx'

/**
 * Pluggable text token counter. `tokenx` is the dialect-agnostic heuristic.
 */
export interface TextTokenizer {
  readonly id: string
  count(text: string): number
}

/** Heuristic tokenizer — `tokenx` character approximation. */
export const tokenxTokenizer: TextTokenizer = {
  id: 'tokenx',
  count: (text) => (text ? estimateTokenCount(text) : 0)
}
