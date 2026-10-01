import type { Context } from '@opentelemetry/api'
import type { BufferConfig, ReadableSpan, Span, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'

import { buildStartSpanSnapshot } from '../core/spanSnapshot'

/** Callback shape of `FunctionSpanProcessor` (not part of the public package surface —). */
type SpanFunction = (span: ReadableSpan) => void

export class FunctionSpanProcessor extends BatchSpanProcessor {
  private start: SpanFunction
  private end: SpanFunction

  constructor(_exporter: SpanExporter, start: SpanFunction, end: SpanFunction, config?: BufferConfig) {
    super(_exporter, config)
    this.start = start
    this.end = end
  }

  override onEnd(span: ReadableSpan): void {
    super.onEnd(span)
    this.end(span)
  }

  override onStart(span: Span, parentContext: Context): void {
    super.onStart(span, parentContext)
    this.start(buildStartSpanSnapshot(span, parentContext))
  }
}
