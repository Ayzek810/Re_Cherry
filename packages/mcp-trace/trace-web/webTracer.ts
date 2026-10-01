import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'

import type { TraceConfig } from '../trace-core/types/config'
import { defaultConfig } from '../trace-core/types/config'
import { TopicContextManager } from './TopicContextManager'

export const contextManager = new TopicContextManager()

export class WebTracer {
  private static provider: WebTracerProvider
  private static processor: SpanProcessor

  static init(config?: TraceConfig, spanProcessor?: SpanProcessor) {
    if (config) {
      defaultConfig.serviceName = config.serviceName || defaultConfig.serviceName
      defaultConfig.endpoint = config.endpoint || defaultConfig.endpoint
      defaultConfig.headers = config.headers || defaultConfig.headers
      defaultConfig.defaultTracerName = config.defaultTracerName || defaultConfig.defaultTracerName
    }
    this.processor = spanProcessor || new BatchSpanProcessor(this.getExporter())
    this.provider = new WebTracerProvider({
      // same as the node adapter — the resource is what makes
      // `serviceName` observable; without it spans report `unknown_service`.
      resource: resourceFromAttributes({ 'service.name': defaultConfig.serviceName }),
      spanProcessors: [this.processor]
    })
    this.provider.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: contextManager
    })
  }

  /** Flush the batch buffer and stop the provider (: the buffer tail used to die with the page). */
  public static async shutdown(): Promise<void> {
    await this.provider?.shutdown()
  }

  public static async forceFlush(): Promise<void> {
    await this.provider?.forceFlush()
  }

  private static getExporter() {
    if (defaultConfig.endpoint) {
      return new OTLPTraceExporter({
        url: `${defaultConfig.endpoint}/v1/traces`,
        headers: defaultConfig.headers
      })
    }
    return new ConsoleSpanExporter()
  }
}

export const startContext = contextManager.startContextForTopic.bind(contextManager)
export const getContext = contextManager.getContextForTopic.bind(contextManager)
export const endContext = contextManager.endContextForTopic.bind(contextManager)
export const cleanContext = contextManager.cleanContextForTopic.bind(contextManager)
