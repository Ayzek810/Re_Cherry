import type { Attributes, Context, Link } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'
import type { InstrumentationScope } from '@opentelemetry/core'
import type { Resource } from '@opentelemetry/resources'
import type { ReadableSpan, Span, TimedEvent } from '@opentelemetry/sdk-trace-base'

/**
 * The published `Span` interface hides the fields the SDK's own span object carries
 * (`attributes`, `resource`, `ended`, …). Two processors used to work around that with
 * inline `as ReadableSpan` casts, which hid real shape mismatches as well .
 * Naming the contract once makes the boundary explicit instead.
 */
type SpanWithReadableFields = Span & {
  readonly endTime: ReadableSpan['endTime']
  readonly duration: ReadableSpan['duration']
  readonly attributes: Attributes
  readonly links: Link[]
  readonly events: TimedEvent[]
  readonly ended: boolean
  readonly resource: Resource
  readonly instrumentationScope: InstrumentationScope
  readonly droppedAttributesCount: number
  readonly droppedEventsCount: number
  readonly droppedLinksCount: number
}

/**
 * Snapshot of a span at its **start** moment, shaped as a `ReadableSpan` so the
 * trace cache can store it before the span ends (two processors used to build
 * this literal inline, byte for byte —).
 *
 * The snapshot is intentionally honest about what a not-yet-ended span has:
 * - `attributes` is a live reference, not a copy: the span keeps mutating it.
 *   Do not treat the snapshot as immutable.
 * - `endTime` is `[0, 0]` and `duration` is `[0, 0]`, exactly as the SDK reports
 *   them for a running span. They are not invented here; downstream conversion
 * reads `ended` instead of guessing from `endTime` .
 */
export function buildStartSpanSnapshot(span: Span, parentContext: Context): ReadableSpan {
  const running = span as SpanWithReadableFields
  return {
    name: running.name,
    kind: running.kind,
    spanContext: () => running.spanContext(),
    parentSpanContext: trace.getSpanContext(parentContext),
    startTime: running.startTime,
    endTime: running.endTime,
    duration: running.duration,
    status: running.status,
    attributes: running.attributes,
    links: running.links,
    events: running.events,
    ended: running.ended,
    resource: running.resource,
    instrumentationScope: running.instrumentationScope,
    droppedAttributesCount: running.droppedAttributesCount,
    droppedEventsCount: running.droppedEventsCount,
    droppedLinksCount: running.droppedLinksCount
  }
}
