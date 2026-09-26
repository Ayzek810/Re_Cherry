// fork 缝：V2 的 ApiGatewayService 挂在生命周期容器上（BaseService/@Injectable/
// DependsOn('RemoteAccessService')，见参考树同名文件）。fork 服务壳照
// deepSeekHarnessService/hermesDashboardService 先例：去装饰器、文件尾单例导出。
// 缝点（行内标注）：
// ① PreferenceService 的 feature.api_gateway.* 四键 → ConfigManager 四对字段
//    （同值的持久化位；先持久化再收敛的 #18521 语义原样保留）；
// ② RemoteAccessService 依赖裁掉（fork 无配对设备子系统）——closeIngress/
//    updateDirectEndpoint/createInvitation 全部消失；lease 计数保留形状但恒无
//    消费者（瞬态消费者子系统如 PDF sidecar 未移植，方法保留签名）；
// ③ CacheService 的 feature.api_gateway.running/lan_running 共享缓存 → 全窗口
//    广播 IpcChannel.CodeCli_ApiGateway_Status（载荷 {running, lanRunning, port?}）；
// ④ onReady 初始收敛 → 构造函数（单例无生命周期钩子；reconciler 后台收敛，
//    需要就绪的调用方走 ensureRunning 的收敛+flush）；
// ⑤ resolveAgentSessionUsage（AgentSessionRuntimeService 归因）随子系统裁掉。

import { timingSafeEqual } from 'node:crypto'

import { Mutex } from 'async-mutex'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import { loggerService } from '@logger'
import { createLatestReconciler, type LatestReconciler } from '@main/core/concurrency/latestReconciler'
import { configManager, ConfigKeys } from '@main/services/ConfigManager'
import { IpcChannel } from '@shared/IpcChannel'
import type { ApiGatewayConfig, ApiGatewayStopOutcome } from '@shared/types/apiGateway'
import { REDACTED } from '@shared/utils/redaction'

import type { ApiGateway } from './server'

const logger = loggerService.withContext('ApiGatewayService')
const AGENT_SESSION_ID_HEADER = 'x-cherry-agent-session-id'
const INTERNAL_USAGE_TOKEN_HEADER = 'x-cherry-internal-usage-token'

class ApiGatewayService {
  private apiGateway: ApiGateway | null = null
  private readonly lanMutex = new Mutex()
  /** Process-local proof that a gateway request originated from Cherry's agent runtime. */
  private readonly internalUsageToken = uuidv4()
  /** Never persisted or exposed through the public API; authenticates Cherry-internal gateway metadata. */
  private readonly internalRequestToken = uuidv4()
  /** Latest persistent desired state. Its only source is the `enabled` config. */
  private desiredEnabled = false
  /**
   * Count of active temporary run leases (see {@link acquireLease}). Transient consumers
   * hold a lease instead of toggling `desiredEnabled`, so the effective running target
   * is `desiredEnabled || leaseCount > 0`: a lease keeps the gateway up without persisting an
   * "enabled" intent, and it never overrides a user who enables/disables the gateway mid-lease.
   * fork 缝②：lease 计数保留形状，恒无消费者（瞬态消费者子系统未移植）。
   */
  private leaseCount = 0
  /** fork 缝：BaseService.isActivated 的单例等价物——字段即"服务器真的在监听"。 */
  private activated = false
  /**
   * Converges the gateway's running state to the effective target (`desiredEnabled || leaseCount`).
   * The reconciler is the SOLE caller of activate/deactivate (start/stop/restart and lease
   * acquire/release route through it too), so transitions are never concurrent. It is
   * level-triggered against the ACTUAL `activated` state, latest-wins (an opposing
   * toggle landing mid-transition is honoured on the next pass), and a transition that throws
   * for a still-current target is recorded — see {@link LatestReconciler.getLastError} — and
   * not retried, so a persistent failure (e.g. port in use) can't spin the loop.
   */
  private readonly reconciler: LatestReconciler = createLatestReconciler<{ desired: boolean; actual: boolean }>({
    name: 'apiGateway',
    getSnapshot: () => ({ desired: this.desiredEnabled || this.leaseCount > 0, actual: this.activated }),
    isSettled: ({ desired, actual }) => desired === actual,
    apply: async ({ desired }) => {
      if (desired) {
        await this.activate()
      } else {
        await this.deactivate()
      }
    }
  })

  constructor() {
    // fork 缝④：V2 onReady 的初始收敛（读 preference → reconciler）。flush 为异步，
    // 单例构造时不等待——需要就绪的调用方走 ensureRunning()。
    const config = this.getCurrentConfig()
    // Never log the raw API key — redact before emitting.
    logger.info('API gateway config:', { ...config, apiKey: config.apiKey ? REDACTED : null })
    this.desiredEnabled = config.enabled
    configManager.subscribe<boolean>(ConfigKeys.ApiGatewayEnabled, (enabled) => {
      this.desiredEnabled = enabled
      this.reconciler.request()
    })
    this.reconciler.request()
  }

  private async activate(): Promise<void> {
    await this.onActivate()
    this.activated = true
  }

  private async deactivate(): Promise<void> {
    await this.onDeactivate()
    this.activated = false
  }

  private async onActivate(): Promise<void> {
    try {
      await this.ensureValidApiKey()
      const { ApiGateway } = await import('./server')
      const { port } = this.getCurrentConfig()
      // Keep the shared listener stable; lanGuard gates LAN access without interrupting
      // local streams (the listener always binds 0.0.0.0, V2 语义)。
      this.apiGateway = new ApiGateway({ host: '0.0.0.0', port })
      await this.apiGateway.start()
      this.publishRunningState(true)
      logger.info('API Gateway activated')
    } catch (error) {
      // Activation failure contract: clean up partial state before throwing
      if (this.apiGateway) {
        await this.apiGateway.stop().catch(() => {})
        this.apiGateway = null
      }
      this.publishRunningState(false)
      throw error
    }
  }

  private async onDeactivate(): Promise<void> {
    if (this.apiGateway) {
      await this.apiGateway.stop()
      this.apiGateway = null
    }
    this.publishRunningState(false)
    logger.info('API Gateway deactivated')
  }

  /**
   * Publish the running state to the renderer（fork 缝③：全窗口广播）。
   *
   * "Running" tracks whether the server is ACTUALLY listening (`activated`) — including when
   * a transient lease holds it up — because renderer consumers gate real actions on it (the
   * settings page disables port / API-key editing while running). A lease must therefore NOT
   * leak into the persisted `enabled` config; that is prevented on the renderer side, not by
   * faking this state.
   */
  private publishRunningState(running: boolean): void {
    const config = this.getCurrentConfig()
    const lanRunning = running && config.enabled && config.host === '0.0.0.0'
    const payload = {
      running,
      lanRunning,
      ...(lanRunning && this.apiGateway ? { port: this.apiGateway.getPort() } : {})
    }
    try {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IpcChannel.CodeCli_ApiGateway_Status, payload)
      }
    } catch (error) {
      logger.warn('Failed to publish API gateway running state', error as Error)
    }
  }

  /**
   * Converge the runtime on `enabled` through the reconciler — never transition directly, so this
   * can't race an opposing toggle; `flush()` waits for the loop to go quiescent.
   */
  private async converge(enabled: boolean): Promise<void> {
    this.desiredEnabled = enabled
    this.reconciler.request()
    await this.reconciler.flush()
  }

  /**
   * Persist the intent BEFORE converging, in the same authoritative call（fork 缝①：写
   * ConfigManager）. A runtime transition whose persisted intent never landed is exactly the
   * divergence #18521 was about — a stop that left `enabled: true` behind reopens the port on
   * the next launch. The config write throws on failure, so the caller learns the intent did
   * not stick.
   */
  private async applyIntent(enabled: boolean): Promise<void> {
    if (!enabled && this.getCurrentConfig().host === '0.0.0.0') {
      configManager.setApiGatewayHost('127.0.0.1')
      configManager.setApiGatewayEnabled(false)
    } else {
      configManager.setApiGatewayEnabled(enabled)
    }
    if (!enabled) await this.lanMutex.runExclusive(() => this.closeRemoteAccess())
    // `configManager.subscribe` fires on every write, so drive the reconciler here as well.
    await this.converge(enabled)
  }

  async start(): Promise<void> {
    await this.applyIntent(true)
    if (!this.activated) {
      const error = this.failureError('Failed to start API Gateway')
      logger.error('Failed to start API Gateway:', error)
      throw error
    }
    logger.info('API Gateway started successfully')
  }

  async stop(): Promise<ApiGatewayStopOutcome> {
    await this.applyIntent(false)
    if (this.activated) {
      if (this.leaseCount > 0) {
        // A transient lease still holds the server open; the reconciler will stop it once the last
        // lease releases. Persistent intent is cleared, so this is a success, not a failure.
        logger.info('API Gateway persistent intent cleared; server stays up for active lease(s)')
        return 'deferred'
      }
      const error = this.failureError('Failed to stop API Gateway')
      logger.error('Failed to stop API Gateway:', error)
      throw error
    }
    logger.info('API Gateway stopped successfully')
    return 'stopped'
  }

  async restart(): Promise<void> {
    if (this.leaseCount > 0) {
      const error = new Error('API Gateway is busy: a temporary run is in progress. Retry once it finishes.')
      logger.warn('Refusing API Gateway restart while a lease is active', error)
      throw error
    }
    // Re-create the server (e.g. to apply a new host/port) as a stop→start through the same single
    // reconciler. A re-bind is not an intent change, so the persisted preference is left alone.
    await this.converge(false)
    // Re-read the intent before re-activating: another window may have persisted a stop while this
    // restart was queued behind it, and a re-bind must never resurrect a gateway the user disabled.
    if (!this.getCurrentConfig().enabled) {
      const error = new Error('API Gateway was disabled while restarting')
      logger.warn('Aborting API Gateway restart: the gateway was disabled meanwhile')
      throw error
    }
    await this.converge(true)
    if (!this.activated) {
      const error = this.failureError('Failed to restart API Gateway')
      logger.error('Failed to restart API Gateway:', error)
      throw error
    }
    logger.info('API Gateway restarted successfully')
  }

  /**
   * Converge an already-enabled gateway toward running. Unlike {@link start} this never touches the
   * persisted intent, so a caller that merely needs the gateway up (an agent route whose model must
   * be bridged) can wait for readiness without being able to re-enable what a user disabled.
   */
  async ensureRunning(): Promise<void> {
    if (!this.getCurrentConfig().enabled) {
      throw new Error('API Gateway is disabled')
    }
    await this.converge(true)
    if (!this.activated) {
      const error = this.failureError('Failed to start API Gateway')
      logger.error('Failed to start API Gateway:', error)
      throw error
    }
  }

  /**
   * Acquire a temporary run lease: keep the gateway running for a transient consumer without
   * touching the persistent `enabled` state. Bumps the effective target (`|| leaseCount > 0`) and
   * converges; throws if the gateway could not be brought up (rolling the lease back first). Every
   * successful `acquireLease()` MUST be paired with a `releaseLease()` (in a `finally`).
   *
   * Unlike `start()`/`stop()`, this never rewrites `desiredEnabled`, so it cannot stop a
   * user-enabled gateway on release, and a user disabling the gateway mid-lease cannot cut a
   * running consumer off (the lease still pins the target true until released).
   */
  async acquireLease(): Promise<void> {
    this.leaseCount += 1
    this.reconciler.request()
    await this.reconciler.flush()
    if (!this.activated) {
      this.leaseCount = Math.max(0, this.leaseCount - 1)
      this.reconciler.request()
      const error = this.failureError('Failed to start API Gateway for a temporary lease')
      logger.error('Failed to acquire API Gateway lease:', error)
      throw error
    }
  }

  /**
   * Release a lease taken by {@link acquireLease}. Fire-and-forget convergence (matching the
   * config-subscription path): once the last lease drops and `desiredEnabled` is false, the
   * reconciler stops the gateway on its own.
   */
  releaseLease(): void {
    this.leaseCount = Math.max(0, this.leaseCount - 1)
    this.reconciler.request()
  }

  /** Surface the reconciler's most recent transition error to an IPC caller, or a generic fallback. */
  private failureError(fallback: string): Error {
    const lastError = this.reconciler.getLastError()
    return lastError instanceof Error ? lastError : new Error(fallback)
  }

  isRunning(): boolean {
    return this.apiGateway?.isRunning() ?? false
  }

  async setLanEnabled(enabled: boolean): Promise<void> {
    await this.lanMutex.runExclusive(async () => {
      if (!enabled) {
        configManager.setApiGatewayHost('127.0.0.1')
        await this.closeRemoteAccess()
        return
      }
      if (!this.getCurrentConfig().enabled || !this.isRunning()) {
        throw new Error('Start the API Gateway in its settings before enabling LAN access')
      }
      configManager.setApiGatewayHost('0.0.0.0')
      if (!this.getCurrentConfig().enabled || !this.isRunning()) {
        configManager.setApiGatewayHost('127.0.0.1')
        await this.closeRemoteAccess()
        throw new Error('API Gateway was stopped')
      }
      this.publishRunningState(this.isRunning())
    })
  }

  /**
   * fork 缝②：V2 此处先 RemoteAccessService.closeIngress() 再发布状态；fork 无该
   * 子系统，仅余状态重发布（方法保留形状）。
   */
  private async closeRemoteAccess(): Promise<void> {
    this.publishRunningState(this.isRunning())
  }

  /**
   * fork 缝①：渲染层设置页的部分更新入口（CodeCli_SyncGatewayConfig）。先持久化
   * 再收敛（#18521 语义——intent 落盘先于任何运行态转换）；enabled 变化驱动
   * reconciler 收敛，port/host 变化只落盘（重新绑定是显式 restart 的职责）。
   */
  async syncConfig(partial: { enabled?: boolean; port?: number; host?: string }): Promise<void> {
    if (partial.port !== undefined) configManager.setApiGatewayPort(partial.port)
    if (partial.host !== undefined) configManager.setApiGatewayHost(partial.host)
    if (partial.enabled !== undefined) {
      configManager.setApiGatewayEnabled(partial.enabled)
      await this.converge(partial.enabled)
    }
  }

  getInternalRequestToken(): string {
    return this.internalRequestToken
  }

  isInternalRequestToken(candidate: string | undefined): boolean {
    if (!candidate) return false
    const expected = Buffer.from(this.internalRequestToken)
    const received = Buffer.from(candidate)
    return expected.length === received.length && timingSafeEqual(expected, received)
  }

  getCurrentConfig(): ApiGatewayConfig {
    return {
      enabled: configManager.getApiGatewayEnabled(),
      host: configManager.getApiGatewayHost(),
      port: configManager.getApiGatewayPort(),
      apiKey: configManager.getApiGatewayApiKey() || null
    }
  }

  async ensureValidApiKey(): Promise<string> {
    let apiKey = configManager.getApiGatewayApiKey()
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      apiKey = `cs-sk-${uuidv4()}`
      configManager.setApiGatewayApiKey(apiKey)
      logger.info('Generated new API key')
    }
    return apiKey
  }

  /**
   * Headers injected only into the Claude Agent SDK subprocess that Cherry
   * launches for this session. They let the HTTP gateway retain per-provider
   * request records while attaching them to the owning agent. fork 缝：V2 的
   * resolveAgentSessionUsage 归因随 AgentSessionRuntimeService 裁掉，头保留形状。
   */
  getAgentSessionUsageHeaders(sessionId: string): Record<string, string> {
    return {
      [AGENT_SESSION_ID_HEADER]: sessionId,
      [INTERNAL_USAGE_TOKEN_HEADER]: this.internalUsageToken
    }
  }

  /** Process-local proof that the request came from a Cherry-launched SDK subprocess. */
  isInternalAgentRequest(headers: Headers): boolean {
    return headers.get(INTERNAL_USAGE_TOKEN_HEADER) === this.internalUsageToken
  }

  /** Validated Agent session id from the internal usage headers; undefined for external requests. */
  getAgentSessionId(headers: Headers): string | undefined {
    if (!this.isInternalAgentRequest(headers)) return undefined
    return headers.get(AGENT_SESSION_ID_HEADER)?.trim() || undefined
  }
}

export const apiGatewayService = new ApiGatewayService()
