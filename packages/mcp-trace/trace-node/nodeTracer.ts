import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

import type { TraceConfig } from '../trace-core/types/config'
import { defaultConfig } from '../trace-core/types/config'

export class NodeTracer {
  private static provider: NodeTracerProvider
  private static spanProcessor: SpanProcessor

  static init(config?: TraceConfig, spanProcessor?: SpanProcessor) {
    if (config) {
      defaultConfig.serviceName = config.serviceName || defaultConfig.serviceName
      defaultConfig.endpoint = config.endpoint || defaultConfig.endpoint
      defaultConfig.headers = config.headers || defaultConfig.headers
      defaultConfig.defaultTracerName = config.defaultTracerName || defaultConfig.defaultTracerName
    }
    this.spanProcessor = spanProcessor || new BatchSpanProcessor(this.getExporter())
    this.provider = new NodeTracerProvider({
      // k2-14: without an explicit resource every exported span carried the SDK
      // default `unknown_service`, so the caller-supplied `serviceName` had no
      // effect at all. The attribute is what the trace view reads.
      resource: resourceFromAttributes({ 'service.name': defaultConfig.serviceName }),
      spanProcessors: [this.spanProcessor]
    })
    this.provider.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: new AsyncLocalStorageContextManager()
    })
  }

  /** Flush the batch buffer and stop the provider. Without this the tail of the buffer dies with the process (k2-20). */
  public static async shutdown(): Promise<void> {
    await this.provider?.shutdown()
  }

  public static async forceFlush(): Promise<void> {
    await this.provider?.forceFlush()
  }

  /**
   * Reads the merged `defaultConfig`, exactly like the web adapter — the old
   * `config?: TraceConfig` parameter was never passed, so an `endpoint` configured
   * by the caller silently degraded to the console exporter (k2-18).
   */
  private static getExporter() {
    if (defaultConfig.endpoint) {
      return new OTLPTraceExporter({
        url: `${defaultConfig.endpoint}/v1/traces`,
        headers: defaultConfig.headers || undefined
      })
    }
    return new ConsoleSpanExporter()
  }
}
