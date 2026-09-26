// fork 移植自 cherry-studio v2 src/renderer/pages/code/utils/modelSupport.ts（2026-09-24，v0.3.4-1 批次4a）。
// fork 缝：switch 按 CodeCli 收窄到保留两键（V2 十四臂）；其余臂随对应工具删除。
// Model ← cliConfig/providerView 投影（endpointTypes 为 V2 字符串面）；端点常量内联
//（V2 为 @shared/data/types/model 的 ENDPOINT_TYPE）。

import { CodeCli } from '@shared/types/codeCli'

import type { Model } from '../cliConfig/providerView'

const ANTHROPIC_MESSAGES = 'anthropic-messages'
const OPENAI_CHAT_COMPLETIONS = 'openai-chat-completions'
const OPENAI_RESPONSES = 'openai-responses'
const OPENAI_LIKE_ENDPOINTS = [OPENAI_CHAT_COMPLETIONS, OPENAI_RESPONSES]

function hasAnyModelEndpoint(model: Model, endpoints: string[]): boolean {
  if (!model.endpointTypes?.length) return true
  return model.endpointTypes.some((endpoint) => endpoints.includes(endpoint))
}

export function modelSupportsCliTool(cliTool: CodeCli, model: Model): boolean {
  switch (cliTool) {
    case CodeCli.DEEPSEEK_HARNESS:
    case CodeCli.HERMES:
      return hasAnyModelEndpoint(model, [ANTHROPIC_MESSAGES, ...OPENAI_LIKE_ENDPOINTS])
    default:
      return false
  }
}
