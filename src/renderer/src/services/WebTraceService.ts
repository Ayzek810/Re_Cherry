import { loggerService } from '@logger'
import { convertSpanToSpanEntity, FunctionSpanExporter, FunctionSpanProcessor } from '@mcp-trace/trace-core'
import { WebTracer } from '@mcp-trace/trace-web'
import { trace } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const logger = loggerService.withContext('WebTraceService')

const TRACER_NAME = 'CherryStudio'

class WebTraceService {
  init() {
    const exporter = new FunctionSpanExporter((spans: ReadableSpan[]): Promise<void> => {
      // Implement your save logic here if needed
      // For now, just resolve immediately
      logger.info(`Saving spans: ${spans.length}`)
      return Promise.resolve()
    })

    const processor = new FunctionSpanProcessor(
      exporter,
      // 开始态不写实体（v1 二轮性能审计 p2-16）：onStart 会构造一个 20 字段的伪
      // ReadableSpan，此前与 onEnd 传同一个回调 ⇒ 每条 span 两次 convertSpanToSpanEntity
      // + 两次 trace.saveEntity IPC。主进程 SpanCacheService.saveEntity 在非开发者模式下
      // 首行即 return（纯开销），开发者模式下则是每条 span 双份入缓存/双份落盘（trace
      // 面板重复行的成因）。span 的"开始态"语义由 BatchSpanProcessor 基线承担，
      // 结束态一次写全（onEnd 的 ReadableSpan 才是完整形态）。
      () => {},
      (span: ReadableSpan) => {
        void window.api.trace.saveEntity(convertSpanToSpanEntity(span))
      }
    )
    WebTracer.init(
      {
        defaultTracerName: TRACER_NAME,
        serviceName: TRACER_NAME
      },
      processor
    )
  }

  getTracer() {
    return trace.getTracer(TRACER_NAME, '1.0.0')
  }
}

export const webTraceService = new WebTraceService()
