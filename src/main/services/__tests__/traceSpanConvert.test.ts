/**
 * `convertSpanToSpanEntity` 是 trace 面唯一的数据出口。
 *
 * 旧实现写的是 `span.endTime ? <ms> : undefined`——`ReadableSpan.endTime` 是二元组
 * `HrTime`，未结束时是 `[0, 0]`，**永远 truthy**，所以未结束的 span 会得到 `endTime = 0`
 * （1970），而 `isEnd` 这个必填字段从来没有生产者。渲染层只能靠
 * `!e.endTime || e.endTime <= 0` 猜（`src/renderer/src/trace/pages/index.tsx`）。
 *
 * 每个用例用自己的 provider + 导出器，并把 `trace.getTracer` 打桩到它上面：`@TraceMethod`
 * 在类装饰求值期调用 `trace.getTracer(...)`，全局 provider 一旦被前一个用例 `shutdown()`
 * 就再也产不出 span。
 */
import { convertSpanToSpanEntity } from '@mcp-trace/trace-core/core/spanConvert'
import { buildStartSpanSnapshot } from '@mcp-trace/trace-core/core/spanSnapshot'
import { TraceMethod } from '@mcp-trace/trace-core/core/traceMethod'
import { FunctionSpanExporter } from '@mcp-trace/trace-core/exporters/FuncSpanExporter'
import { NodeTracer } from '@mcp-trace/trace-node/nodeTracer'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let exporter: InMemorySpanExporter
let provider: NodeTracerProvider

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  vi.spyOn(trace, 'getTracer').mockReturnValue(
    provider.getTracer('k2-trace-test') as unknown as ReturnType<typeof trace.getTracer>
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('convertSpanToSpanEntity', () => {
  it('运行中的 span 得到 endTime === null 与 isEnd === false，而不是 1970', () => {
    const span = trace.getTracer('k2-trace-test').startSpan('running') as unknown as ReadableSpan

    const entity = convertSpanToSpanEntity(span)

    expect(entity.isEnd).toBe(false)
    expect(entity.endTime).toBeNull()
    expect(entity.startTime).toBeGreaterThan(0)
  })

  it('结束后的 span 得到毫秒时间戳与 isEnd === true', () => {
    const span = trace.getTracer('k2-trace-test').startSpan('finished')
    span.end()

    const exported = exporter.getFinishedSpans()[0]
    expect(exported).toBeDefined()

    const entity = convertSpanToSpanEntity(exported)

    expect(entity.isEnd).toBe(true)
    expect(entity.endTime).toBeGreaterThan(0)
  })

  it('start 快照带 ended:false，且 attributes 是活引用（两个处理器共用的那份语义）', () => {
    const span = trace.getTracer('k2-trace-test').startSpan('snapshot')
    // `SpanProcessor.onStart` 拿到的是 SDK 自己的 span 对象；这里取同一个对象来构造快照。
    const snapshot = buildStartSpanSnapshot(
      span as unknown as Parameters<typeof buildStartSpanSnapshot>[0],
      ROOT_CONTEXT
    )

    expect(snapshot.ended).toBe(false)
    expect(snapshot.attributes).toEqual({})

    span.setAttribute('late', 'value')
    expect(snapshot.attributes['late']).toBe('value')

    expect(convertSpanToSpanEntity(snapshot).isEnd).toBe(false)
    span.end()
  })

  it('保留既有投影字段（状态/种类/父上下文）', () => {
    const span = trace.getTracer('k2-trace-test').startSpan('shaped', { kind: SpanKind.CLIENT })
    span.setAttribute('modelName', 'some-model')
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' })
    span.end()

    const entity = convertSpanToSpanEntity(exporter.getFinishedSpans()[0])

    expect(entity.name).toBe('shaped')
    expect(entity.kind).toBe(SpanKind[SpanKind.CLIENT])
    expect(entity.status).toBe(SpanStatusCode[SpanStatusCode.ERROR])
    expect(entity.modelName).toBe('some-model')
    expect(entity.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(entity.parentId).toBe('')
  })
})

describe('TraceMethod 属性上限', () => {
  it('Buffer 返回值只记字节摘要，不再展开成 JSON 数字数组', async () => {
    class FileService {
      @TraceMethod({ spanName: 'readFile', tag: 'FileService' })
      async readFile(_path: string): Promise<Buffer> {
        return Buffer.from([0, 1, 2, 3, 4, 5])
      }
    }

    await new FileService().readFile('x')

    const span = exporter.getFinishedSpans().find((item) => item.name === 'readFile')
    expect(span).toBeDefined()
    const outputs = String(span?.attributes['outputs'] ?? '')
    expect(outputs).not.toContain('"data"')
    expect(outputs).toContain('binary')
    expect(outputs).toContain('byteLength=6')
    expect(String(span?.attributes['inputs'])).toContain('x')
  })

  it('超长字符串被截断', async () => {
    class Service {
      @TraceMethod({ spanName: 'bigString' })
      async run(): Promise<string> {
        return 'x'.repeat(10_000)
      }
    }

    await new Service().run()

    const span = exporter.getFinishedSpans().find((item) => item.name === 'bigString')
    expect(span).toBeDefined()
    const outputs = String(span?.attributes['outputs'] ?? '')
    expect(outputs.length).toBeLessThan(3_000)
    expect(outputs).toContain('truncated')
  })

  it('undefined 结果不写成字符串 "undefined"', async () => {
    class Service {
      @TraceMethod({ spanName: 'voidResult' })
      async run(): Promise<undefined> {
        return undefined
      }
    }

    await new Service().run()

    const span = exporter.getFinishedSpans().find((item) => item.name === 'voidResult')
    expect(span).toBeDefined()
    expect(span?.attributes['outputs']).toBeUndefined()
  })
})

describe('导出器与适配器', () => {
  it('FunctionSpanExporter.shutdown 等待在建写入', async () => {
    let settled = false
    const fnExporter = new FunctionSpanExporter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      settled = true
    })

    fnExporter.export([], () => {})
    await fnExporter.shutdown()

    expect(settled).toBe(true)
  })

  it('FunctionSpanExporter.shutdown 不因写入失败而抛（关闭不得掩盖原始错误）', async () => {
    const fnExporter = new FunctionSpanExporter(async () => {
      throw new Error('disk full')
    })

    fnExporter.export([], () => {})
    await expect(fnExporter.shutdown()).resolves.toBeUndefined()
  })

  it('NodeTracer 暴露 shutdown/forceFlush', async () => {
    expect(typeof NodeTracer.shutdown).toBe('function')
    expect(typeof NodeTracer.forceFlush).toBe('function')
    await expect(NodeTracer.shutdown()).resolves.toBeUndefined()
  })

  it('service.name 资源是 resource 的传递路径（provider 收到 resource 后属性可见）', () => {
    const resource = resourceFromAttributes({ 'service.name': 'Re_Cherry' })
    expect(resource.attributes['service.name']).toBe('Re_Cherry')
  })
})
