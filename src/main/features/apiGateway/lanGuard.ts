// fork 缝：V2 的 lanGuard 依赖 @application（PreferenceService）与
// routes/remote 的 REMOTE_CONNECT_PATH（配对设备加密通道）。fork 无配对设备
// 子系统，也不存在 LAN 上合法的升级路径，故：
// - 配置读取换 ConfigManager（同值的持久化位）；
// - REMOTE_CONNECT_PATH 特判整枝裁掉——LAN 绑定（host=0.0.0.0）下 HTTP 面
//   对非回环 peer 一律 403，与 V2 "除升级路径外无任何 HTTP 路由可越 LAN" 的
//   安全姿态等价（fork 的 LAN 上没有任何可达路由）。
// isLoopbackAddress / readRemoteAddress 函数体逐字。

import { configManager } from '@main/services/ConfigManager'

/**
 * When the gateway binds the LAN (`0.0.0.0`) the same listener serves the
 * desktop's own loopback consumers. No HTTP route may cross the LAN: an exposed
 * proxy is remote code execution, and the chat routes leak the API key over the
 * wire. This screens every request by its socket peer.
 */

/**
 * A missing address is treated as loopback: it only occurs for in-process
 * `app.handle()` calls that never touch a socket, never for a real remote peer.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return true
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** The srvx Node request exposes the peer address as `.ip` (its raw socket underneath). */
function readRemoteAddress(request: Request): string | undefined {
  const carrier = request as {
    ip?: string
    runtime?: { node?: { req?: { socket?: { remoteAddress?: string } } } }
  }
  return carrier.ip ?? carrier.runtime?.node?.req?.socket?.remoteAddress
}

/** Returns a 403 body for every non-loopback request. */
export function screenLanRequest(request: Request, _pathname: string): { error: string } | undefined {
  // 批次5 真机 403 事故修复：V2 原文（lanGuard.ts L40-44）的顺序是「回环放行 → LAN
  // enabled 检查只管非回环 peer」。3b 裁掉 remote 分支时把 enabled 检查提到了回环检查
  // 之前——LAN 开关关闭（默认）时连 127.0.0.1 上的 dsh 请求都被 403（"LAN access is
  // disabled"），网关完全不可用。按 V2 原序恢复：回环无条件放行。
  if (isLoopbackAddress(readRemoteAddress(request))) return undefined
  const enabled = configManager.getApiGatewayEnabled() && configManager.getApiGatewayHost() === '0.0.0.0'
  if (!enabled) return { error: 'Forbidden: LAN access is disabled' }
  return { error: 'Forbidden: this endpoint is not reachable over the LAN' }
}
