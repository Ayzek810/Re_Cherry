// fork 缝：统一网关的 CodeMate 接入点（2026-09-24，v0.3.4-1；批次3b 填充，批次5 修正）。
// V2 语义（DeepSeekHarnessService 网关分支 L102 原文）：`await gateway.start()`——完整意图
// 启动（先持久化 enabled=true 再收敛拉起服务器）。用户在 CodeMate 里显式选择"统一网关"
// 供应商即是同意，走 ensureRunning（只收敛不写 intent）会在 enabled=false 默认值下抛
// "API Gateway is disabled"（真机事故，批次5 修复）。key 保证存在 + 读当前端口。
// 经 apiGatewayService 单例（同 deepSeekHarnessService 先例），非 V2 的容器 app-service 插件。

import { apiGatewayService } from '@main/features/apiGateway/ApiGatewayService'

export interface GatewayRuntime {
  /** 网关 API key（唯一 Bearer token，主进程生成与保管）。 */
  credentialValue: string
  /** 网关 OpenAI 兼容端点根（http://127.0.0.1:<port>/v1）。 */
  baseUrl: string
}

export async function startGatewayForCodeMate(): Promise<GatewayRuntime> {
  // 完整意图启动（V2 原文同款）：用户选网关 = 同意启用；先落盘 enabled 再收敛，
  // 失败（端口占用等）原样上抛给启动对话框。
  await apiGatewayService.start()
  const credentialValue = await apiGatewayService.ensureValidApiKey()
  const { port } = apiGatewayService.getCurrentConfig()
  return { credentialValue, baseUrl: `http://127.0.0.1:${port}` }
}
