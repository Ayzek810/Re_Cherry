/**
 * 网关监听器的关闭语义（从 `server.ts` 抽出，便于单测——`server.ts` 经 `./app`
 * 拉进整条网关依赖图，在 vitest 的 electron 桩下不可实例化）。
 *
 * v1 二轮审查 m2-04 的背景：关闭链此前刻意「永不 reject」——`stop()` 的失败只落一行 warn、
 * 超时也不再等，而网关服务侧无条件把状态改口为「已停」。结果是「开关是关的、端口是占的」，
 * 且此后同端口 `start()` 只会撞 EADDRINUSE，错误信息与网关无关。
 *
 * 本模块把「是否真的关闭」变成显式返回值，并保留句柄语义：调用方据此决定是清空句柄
 * 还是留着让下一次 stop 重试。
 */
import { loggerService } from '@logger'

const logger = loggerService.withContext('ApiGateway')

/** 关闭链路实际消费的底层监听器表面（`http.Server` 的窄化投影，测试可注入）。 */
export interface CloseableHttpServer {
  readonly listening?: boolean
  closeAllConnections?: () => void
}

/** Resolves `true` if `promise` settled within `ms`, `false` on timeout — the promise keeps running. */
export function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** 关闭链路消费的最小形状：`stop()` 与该适配器暴露的底层 Node http server。 */
export interface CloseableServerInfo {
  stop?: () => unknown
  raw?: { node?: { server?: CloseableHttpServer } }
}

/**
 * Close the underlying Node http server, destroying leftover sockets once the grace period is up.
 *
 * `close()` releases the listening handle at once but only settles when the last connection ends.
 * A proxied SSE response is exactly such a connection and may never end on its own — the socket
 * timeout is disabled — so awaiting it alone leaves the user's off switch spinning forever.
 *
 * Returns `true` only when the listener is really down: `stop()` settled **and** the http server no
 * longer reports `listening`. A `stop()` rejection, or a socket still listening after the second
 * grace period, means `false` — the caller must keep the handle and surface the failure.
 */
export async function closeServerInfo(
  serverInfo: CloseableServerInfo | null | undefined,
  graceMs: number
): Promise<boolean> {
  const http = serverInfo?.raw?.node?.server
  let closeFailed = false
  // `stop()` must never reject here: the service's deactivate rethrows, which would strand the
  // service activated. The failure is reported through the return value instead.
  const closed = Promise.resolve(serverInfo?.stop?.()).catch((error: unknown) => {
    closeFailed = true
    logger.warn('API server close failed', error as Error)
  })

  const settle = async (): Promise<boolean> => {
    const settled = await settledWithin(closed, graceMs)
    return settled && !closeFailed && (http?.listening ?? false) === false
  }

  if (await settle()) return true

  logger.warn('API server still has open connections after the grace period; destroying them')
  http?.closeAllConnections?.()
  // Stop waiting either way — the port is released once the listener stops, whatever the remaining
  // sockets do.
  return await settle()
}
