import type { Context } from '@opentelemetry/api'
import type { BufferConfig, ReadableSpan, Span, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { buildStartSpanSnapshot } from '../core/spanSnapshot'
import type { TraceCache } from '../core/traceCache'

export class CacheBatchSpanProcessor extends BatchSpanProcessor {
  private cache: TraceCache

  constructor(_exporter: SpanExporter, cache: TraceCache, config?: BufferConfig) {
    super(_exporter, config)
    this.cache = cache
  }

  override onEnd(span: ReadableSpan): void {
    super.onEnd(span)
    this.cache.endSpan(span)
  }

  override onStart(span: Span, parentContext: Context): void {
    super.onStart(span, parentContext)
    this.cache.createSpan(buildStartSpanSnapshot(span, parentContext))
  }
}
