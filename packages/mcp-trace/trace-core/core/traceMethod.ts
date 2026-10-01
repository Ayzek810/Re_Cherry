import 'reflect-metadata'

import { SpanStatusCode, trace } from '@opentelemetry/api'

import { defaultConfig } from '../types/config'

export interface SpanDecoratorOptions {
  spanName?: string
  traceName?: string
  tag?: string
}

/**
 * `@TraceMethod` is applied to main-process file services whose arguments and
 * return values can be large (`FileSystemService.readFile` returns a `Buffer`).
 * `JSON.stringify(Buffer)` expands to `{"type":"Buffer","data":[0,1,…]}` — about
 * five characters per byte — so an unbounded serialization allocated tens of
 * megabytes on a synchronous path and pushed it into span attributes .
 *
 * Binary payloads are summarized, and every string is capped. `TraceConfig` used
 * to reserve a `maxAttributesPerSpan` field that nothing read; the cap below is
 * the brake, so the dead field is gone instead of looking configurable.
 */
const MAX_ATTRIBUTE_CHARS = 2048

function summarizeBinary(value: ArrayBufferView | ArrayBuffer): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  const head = Array.from(bytes.subarray(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `[binary ${value.constructor.name} byteLength=${bytes.byteLength} head=${head}]`
}

function truncate(text: string): string {
  return text.length > MAX_ATTRIBUTE_CHARS ? `${text.slice(0, MAX_ATTRIBUTE_CHARS)}…<truncated>` : text
}

/** `undefined` means "no attribute": an absent value is not a value of the string "undefined". */
function convertToString(args: any): string | boolean | number | undefined {
  if (args === undefined) return undefined
  if (typeof args === 'string') return truncate(args)
  if (typeof args === 'boolean' || typeof args === 'number') {
    return args
  }
  if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) {
    return summarizeBinary(args)
  }
  const serialized = JSON.stringify(args)
  return serialized === undefined ? undefined : truncate(serialized)
}

function setAttribute(span: { setAttribute: (key: string, value: any) => unknown }, key: string, value: unknown) {
  if (value === undefined) return
  span.setAttribute(key, value)
}

export function TraceMethod(traced: SpanDecoratorOptions) {
  return function (target: any, propertyKey?: any, descriptor?: PropertyDescriptor) {
    // 兼容静态方法装饰器只传2个参数的情况
    if (!descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(target, propertyKey)
    }
    if (!descriptor || typeof descriptor.value !== 'function') {
      throw new Error('TraceMethod can only be applied to methods.')
    }

    const originalMethod = descriptor.value
    const traceName = traced.traceName || defaultConfig.defaultTracerName || 'default'
    const tracer = trace.getTracer(traceName)

    descriptor.value = function (...args: any[]) {
      const name = traced.spanName || propertyKey
      return tracer.startActiveSpan(name, async (span) => {
        try {
          setAttribute(span, 'inputs', convertToString(args))
          span.setAttribute('tags', traced.tag || '')
          const result = await originalMethod.apply(this, args)
          setAttribute(span, 'outputs', convertToString(result))
          span.setStatus({ code: SpanStatusCode.OK })
          return result
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message
          })
          span.recordException(err)
          throw error
        } finally {
          span.end()
        }
      })
    }
    return descriptor
  }
}
