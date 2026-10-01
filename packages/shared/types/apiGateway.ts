// fork 缝：V2 的 @shared/types/apiGateway 未随共享层整体移植，此处按主进程
// ApiGatewayService 与 IPC handler 的实际消费面落最小同名词表（字段与 V2 一致）。

export type ApiGatewayConfig = {
  enabled: boolean
  host: string
  port: number
  apiKey: string | null
}

/** Result of an API-gateway start/restart IPC call. */
export type ApiGatewayStatusResult = { success: true } | { success: false; error: string }

/**
 * Result of an API-gateway stop IPC call.
 *
 * `'deferred'`（临时租约仍持有服务器）已删除——租约计数随瞬态
 * 消费者子系统裁掉，恒无消费者，该分支永假。关闭失败不再伪装成成功：IPC 返回
 * `{ success: false, error }`（含"端口仍被占用"的可行动文案）。
 */
export type ApiGatewayStopOutcome = 'stopped'
export type ApiGatewayStopResult = { success: true; outcome: ApiGatewayStopOutcome } | { success: false; error: string }
