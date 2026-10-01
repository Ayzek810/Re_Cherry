import type { Link } from '@opentelemetry/api'
import type { TimedEvent } from '@opentelemetry/sdk-trace-base'

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>
  | { [key: string]: string | number | boolean }
  | Array<null | undefined | { [key: string]: string | number | boolean }>

export type Attributes = {
  [key: string]: AttributeValue
}

export interface TelemetryConfig {
  serviceName: string
  endpoint?: string
  headers?: Record<string, string>
  defaultTracerName?: string
}

/**
 * Adapter configuration. There is no per-span attribute budget here: the one cap
 * that exists lives in `core/traceMethod.ts` . A field nothing reads only
 * made the cap look configurable.
 */
export type TraceConfig = TelemetryConfig

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    [key: string]: number
  }
}

export interface SpanEntity {
  id: string
  name: string
  parentId: string
  traceId: string
  status: string
  kind: string
  attributes: Attributes | undefined
  /** Span completion flag (`ReadableSpan.ended`). The trace page reads this instead of guessing from `endTime`. */
  isEnd: boolean
  events: TimedEvent[] | undefined
  startTime: number
  /** Milliseconds since epoch, or `null` while the span has not ended (never `0`/1970). */
  endTime: number | null
  links: Link[] | undefined
  topicId?: string
  usage?: TokenUsage
  modelName?: string
}

export const defaultConfig: TelemetryConfig = {
  serviceName: 'default',
  headers: {},
  defaultTracerName: 'default'
}
