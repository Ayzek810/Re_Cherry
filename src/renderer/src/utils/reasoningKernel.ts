import { isReasoningModel } from '@renderer/config/models'
import type { Model, ThinkingOption } from '@renderer/types'
import { type CherryThinkingOption, type KernelReasoningLevel } from '@shared/config/reasoning'

/**
 * UI 常驻档位（与具体模型无关）：关 / 自动 / 低 / 中 / 高 / 满。
 * 自动（与历史 'default' 取值）始终落到"低"作为默认档位。
 */
export const REASONING_UI_OPTIONS: readonly CherryThinkingOption[] = ['none', 'auto', 'low', 'medium', 'high', 'max']

const CHERRY_TO_KERNEL_LEVEL: Record<CherryThinkingOption, KernelReasoningLevel | undefined> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
  max: 'max',
  auto: 'low', // 自动的默认状态 = 低
  default: 'low' // 历史 'default' 取值按"自动→低"处理
}

/** 思考档位菜单/选项列表（模型无关，常驻六项）。非思考模型返回空（UI 据此隐藏入口）。 */
export function reasoningOptionsForModel(model: Model | undefined): ThinkingOption[] {
  if (model === undefined) return []
  if (!isReasoningModel(model)) return []
  return [...REASONING_UI_OPTIONS]
}

/** 把 Cherry 档位翻译为内核档位（pi-ai ReasoningEffortId）。 */
export function kernelReasoningLevelFor(
  model: Model | undefined,
  option: ThinkingOption | undefined
): string | undefined {
  if (model === undefined || option === undefined) return undefined
  if (!isReasoningModel(model)) return undefined
  return CHERRY_TO_KERNEL_LEVEL[option as CherryThinkingOption]
}

/**
 * 模型可声明给内核 provider 路由的思考能力（pi-ai reasoningEfforts）。
 * 推理模型统一声明 关+低/中/高/满，保证 pi-ai 判 reasoning=true；非推理模型不声明。
 */
export function kernelReasoningEffortsForModel(model: Model | undefined): Record<string, string | null> | undefined {
  if (model === undefined) return undefined
  if (!isReasoningModel(model)) return undefined
  return {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max'
  }
}
