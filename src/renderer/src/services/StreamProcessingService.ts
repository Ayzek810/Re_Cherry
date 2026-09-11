import { loggerService } from '@logger'
import type {
  ExternalToolResult,
  GenerateImageResponse,
  MCPToolResponse,
  NormalToolResponse,
  WebSearchResponse
} from '@renderer/types'
import type { ProviderMetadata } from '@renderer/types/chunk'
import type { Response } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'

const logger = loggerService.withContext('StreamProcessingService')

// Define the structure for the callbacks that the StreamProcessor will invoke
export interface StreamProcessorCallbacks {
  // LLM response created
  onLLMResponseCreated?: () => void
  // Text content start
  onTextStart?: () => void
  // Text content chunk received
  onTextChunk?: (text: string, providerMetadata?: ProviderMetadata) => void
  // Full text content received
  onTextComplete?: (text: string, providerMetadata?: ProviderMetadata) => void
  // thinking content start
  onThinkingStart?: () => void
  // Thinking/reasoning content chunk received (e.g., from Claude)
  onThinkingChunk?: (text: string, thinking_millsec?: number) => void
  onThinkingComplete?: (text: string, thinking_millsec?: number) => void
  // A tool call response chunk (from MCP)
  onToolCallPending?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  onToolCallInProgress?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  onToolCallComplete?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  // Tool argument streaming (partial arguments during streaming)
  onToolArgumentStreaming?: (toolResponse: MCPToolResponse | NormalToolResponse) => void
  // External tool call in progress
  onExternalToolInProgress?: () => void
  // Citation data received (e.g., from Internet and  Knowledge Base)
  onExternalToolComplete?: (externalToolResult: ExternalToolResult) => void | Promise<void>
  // LLM Web search in progress
  onLLMWebSearchInProgress?: () => void
  // LLM Web search complete
  onLLMWebSearchComplete?: (llmWebSearchResult: WebSearchResponse) => void
  // Get citation block ID
  getCitationBlockId?: () => string | null
  // Set citation block ID
  setCitationBlockId?: (blockId: string) => void
  // Image generation chunk received
  onImageCreated?: () => void
  onImageDelta?: (imageData: GenerateImageResponse) => void
  onImageGenerated?: (imageData?: GenerateImageResponse) => void
  onLLMResponseComplete?: (response?: Response) => void
  // Called when an error occurs during chunk processing
  onError?: (error: any) => void
  // Called when the entire stream processing is signaled as complete (success or failure)
  onComplete?: (status: AssistantMessageStatus, response?: Response) => void
  onVideoSearched?: (video?: { type: 'url' | 'path'; content: string }, metadata?: Record<string, any>) => void
  // Called when a block is created
  onBlockCreated?: () => void
  // Called when raw data is received (e.g., session_id updates from Agent SDK)
  onRawData?: (content: unknown, metadata?: Record<string, any>) => void
}

