import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

/** Export callback shape of `FunctionSpanExporter` (not part of the public package surface — k2-21). */
type SaveFunction = (spans: ReadableSpan[]) => Promise<void>

export class FunctionSpanExporter implements SpanExporter {
  private exportFunction: SaveFunction

  // k2-20: `shutdown()` used to resolve immediately, so a shutdown that landed while an
  // export was still running could drop that batch. Shutdown now waits for the writes
  // that are already in flight; a failed write must not make shutdown throw.
  private pending = new Set<Promise<void>>()

  constructor(fn: SaveFunction) {
    this.exportFunction = fn
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const write = this.exportFunction(spans)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error })
      })
      .finally(() => {
        this.pending.delete(write)
      })
    this.pending.add(write)
  }
}
