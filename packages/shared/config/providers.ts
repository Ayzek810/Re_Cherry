/**
 * @fileoverview Shared provider configuration for Claude Code and Anthropic API compatibility
 *
 * This module defines which providers are routed to the Anthropic API endpoint.
 * Used by both the Code Tools page and the Anthropic SDK client.
 */

import { SystemProviderIds } from '@types'

export const CLAUDE_OFFICIAL_SUPPORTED_PROVIDERS = [
  'deepseek',
  'moonshot',
  'zhipu',
  'dashscope',
  'modelscope',
  'minimax',
  'longcat',
  SystemProviderIds.qiniu,
  SystemProviderIds.silicon,
  SystemProviderIds.mimo,
  SystemProviderIds.stepfun,
  SystemProviderIds.openrouter
]
export const CLAUDE_SUPPORTED_PROVIDERS = [
  'aihubmix',
  'dmxapi',
  'new-api',
  '302ai',
  ...CLAUDE_OFFICIAL_SUPPORTED_PROVIDERS
]
