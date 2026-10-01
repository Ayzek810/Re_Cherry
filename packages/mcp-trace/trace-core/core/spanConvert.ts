import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import type { Attributes, AttributeValue, SpanEntity } from '../types/config'

/**
 * convert ReadableSpan to SpanEntity
 *
 * `endTime` is `null` while the span runs: `ReadableSpan.endTime` is a two-element
 * `HrTime` that is **always truthy** (`[0, 0]` before the span ends), so the old
 * `span.endTime ? … : undefined` branch was unreachable and a running span came out
 * as the 1970 epoch (k2-22). `isEnd` carries the answer instead, and the trace page
 * reads it rather than guessing from `endTime <= 0` (k2-23).
 *
 * @param span ReadableSpan
 * @returns SpanEntity
 */
export function convertSpanToSpanEntity(span: ReadableSpan): SpanEntity {
  const modelName = span.attributes?.modelName
  return {
    id: span.spanContext().spanId,
    traceId: span.spanContext().traceId,
    parentId: span.parentSpanContext?.spanId || '',
    name: span.name,
    startTime: span.startTime[0] * 1e3 + Math.floor(span.startTime[1] / 1e6), // 转为毫秒
    endTime: span.ended ? span.endTime[0] * 1e3 + Math.floor(span.endTime[1] / 1e6) : null, // 转为毫秒
    // OTel 的类型带上 `undefined`；实体只留真实存在的属性（旧写法用 `as SpanEntity` 把
    // 这处不符一起盖住了 —— k2-23）。
    attributes: Object.fromEntries(
      Object.entries(span.attributes ?? {}).filter(([, value]) => value !== undefined)
    ) as Attributes,
    status: SpanStatusCode[span.status.code],
    events: span.events,
    kind: SpanKind[span.kind],
    links: span.links,
    isEnd: span.ended,
    // OTel attribute values are wider than string; the field only feeds display.
    modelName: modelName === undefined ? undefined : String(modelName as AttributeValue)
  }
}
