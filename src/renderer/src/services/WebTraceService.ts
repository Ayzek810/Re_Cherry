import { convertSpanToSpanEntity, FunctionSpanExporter, FunctionSpanProcessor } from '@mcp-trace/trace-core'
import { WebTracer } from '@mcp-trace/trace-web'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

const TRACER_NAME = 'CherryStudio'

class WebTraceService {
  /** 幂等门禁（v1 二轮性能审计 p2-05）：`init()` 现在可能在 store rehydrate 后被再次触发。 */
  private initialized = false

  init() {
    if (this.initialized) return
    this.initialized = true

    // r2-61：这个 exporter 是**刻意**的空实现——真实落盘在下面的 onEnd
    // （`window.api.trace.saveEntity`）。此前它打 `logger.info('Saving spans: …')`：既不落盘
    // （渲染层 info 进不了日志文件），又谎称在保存 span，与 onEnd 的真实写入构成两处"真相"。
    // 保留空实现是因为 `BatchSpanProcessor` 构造必须收一个 exporter；这里显式说明它没有副作用。
    const exporter = new FunctionSpanExporter((_spans: ReadableSpan[]): Promise<void> => {
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
}

export const webTraceService = new WebTraceService()
