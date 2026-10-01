import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import type { Server } from 'elysia/universal/server'
import type { Server as HttpServer } from 'http'

import { type ApiGatewayApp, buildApp } from './app'
import type { CloseableServerInfo } from './serverShutdown'
import { closeServerInfo } from './serverShutdown'

const logger = loggerService.withContext('ApiGateway')

const GLOBAL_REQUEST_TIMEOUT_MS = 5 * 60_000
const GLOBAL_HEADERS_TIMEOUT_MS = GLOBAL_REQUEST_TIMEOUT_MS + 5_000
const GLOBAL_KEEPALIVE_TIMEOUT_MS = 60_000
/** How long a still-running response may delay shutdown before its socket is destroyed. */
const SHUTDOWN_GRACE_MS = 3_000

/**
 * `@elysia/node` resolves the listen callback's argument to Elysia's Bun-shaped
 * `Server` (which provides `stop()`), but at runtime hands back a srvx-backed object
 * that also carries `.raw` internals not present in that type. We widen the real
 * `Server` with exactly the `.raw` shape we read — so no cast is needed.
 */
type NodeServerInfo = CloseableServerInfo &
  Server & {
    raw?: {
      // Node's `http.Server` — exposes the timeout knobs we set below.
      node?: { server?: HttpServer }
      // srvx `NodeServer`: `ready()` resolves once listening (rejects on EADDRINUSE etc.).
      ready?: () => Promise<unknown>
    }
  }
export class ApiGateway {
  private app: ApiGatewayApp | null = null
  private serverInfo: NodeServerInfo | null = null
  private running = false

  constructor(private readonly endpoint?: { host: string; port: number }) {}

  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Server already running')
      return
    }

    const port = this.endpoint?.port ?? configManager.getApiGatewayPort()
    const host = this.endpoint?.host ?? configManager.getApiGatewayHost()

    const app = buildApp({ host, port })
    this.app = app

    return new Promise((resolve, reject) => {
      try {
        app.listen({ port, hostname: host }, (serverInfo: NodeServerInfo) => {
          this.serverInfo = serverInfo

          const http = serverInfo.raw?.node?.server
          if (http) {
            this.applyServerTimeouts(http)
          }

          // The listen callback fires synchronously before the socket is bound;
          // await the underlying NodeServer's `ready()` to surface listen errors
          // (e.g. EADDRINUSE), mirroring the previous Express `'error'` handling.
          const ready = serverInfo.raw?.ready
          if (typeof ready === 'function') {
            ready
              .call(serverInfo.raw)
              .then(() => {
                this.running = true
                logger.info('API server started', { host, port })
                resolve()
              })
              .catch((error: unknown) => {
                this.cleanupFailedStart()
                reject(error instanceof Error ? error : new Error(String(error)))
              })
          } else {
            this.running = true
            logger.info('API server started', { host, port })
            resolve()
          }
        })
      } catch (error) {
        this.cleanupFailedStart()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private applyServerTimeouts(server: HttpServer): void {
    server.requestTimeout = GLOBAL_REQUEST_TIMEOUT_MS
    server.headersTimeout = Math.max(GLOBAL_HEADERS_TIMEOUT_MS, server.requestTimeout + 1_000)
    server.keepAliveTimeout = GLOBAL_KEEPALIVE_TIMEOUT_MS
    server.setTimeout(0)
  }

  private cleanupFailedStart(): void {
    this.running = false
    this.serverInfo = null
    this.app = null
  }

  /**
   * Stop the listener and report whether it truly closed.
   *
   * `stop()` 此前永不 reject，调用方无从知道端口是否真的释放了——
   * 关不掉时服务状态已经改口为「已停」、端口却仍被占。返回值把这件事变成调用方可消费的事实。
   */
  async stop(): Promise<boolean> {
    if (!this.app && !this.serverInfo) return true

    const closed = await closeServerInfo(this.serverInfo, SHUTDOWN_GRACE_MS)
    if (closed) {
      this.running = false
      this.serverInfo = null
      this.app = null
      logger.info('API server stopped')
    } else {
      // 保留句柄：端口仍被占用时下一次 stop 还要有重试入口。
      logger.warn('API server did not close; keeping the handle so a later stop can retry')
    }
    return closed
  }

  isRunning(): boolean {
    const http = this.serverInfo?.raw?.node?.server
    const result = this.running && (http?.listening ?? true)
    logger.debug('isRunning check', { running: this.running, listening: http?.listening, result })
    return result
  }

  getPort(): number {
    const address = this.serverInfo?.raw?.node?.server?.address()
    if (!address || typeof address === 'string') throw new Error('API Gateway is not listening on a TCP port')
    return address.port
  }
}
