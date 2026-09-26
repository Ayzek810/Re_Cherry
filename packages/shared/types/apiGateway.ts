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

export type ApiGatewayStopOutcome = 'stopped' | 'deferred'
export type ApiGatewayStopResult = { success: true; outcome: ApiGatewayStopOutcome } | { success: false; error: string }
