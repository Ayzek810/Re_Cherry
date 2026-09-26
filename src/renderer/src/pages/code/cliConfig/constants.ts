// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/constants.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：常量表按 hermes 依赖闭包裁剪——CODEX_*/OPENCODE_SCHEMA/OPEN_CODE_ENDPOINTS/PI_ENDPOINTS/
// MINIMAX_ENDPOINTS 随对应 adapter 整块删除；HERMES_ENDPOINTS/CHERRY_PROVIDER_PREFIX 逐字保留。

import type { EndpointType } from './providerView'

export const CHERRY_PROVIDER_PREFIX = 'cherry-'

export const HERMES_ENDPOINTS: readonly EndpointType[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions'
]
