import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { powerMonitor } from 'electron'

import { windowService } from './WindowService'

const logger = loggerService.withContext('PowerMonitorService')

/**
 * 系统电源事件守护（移植自上游 V1 的 PowerMonitorService，按 fork 实际改造）。
 *
 * 与上游的差异及原因：
 * - 不引入 `@paymoapp/electron-shutdown-handler`（本环境 pnpm 不可用，禁止新依赖）。
 *   上游靠它在 Windows 上用隐藏窗口拦 WM_QUERYENDSESSION 实现关机钩子；fork 没有
 *   这个能力，Windows 关机/注销因此没有 JS 侧可靠钩子——能力缺口见下方平台矩阵
 *   与数据安全兜底说明。
 * - 上游的 `registerShutdownHandler` 注册表不移植：fork 的关机收尾集中写在
 *   `src/main/index.ts` 的 `before-quit`（App_SaveData + 子进程同步杀树）与
 *   `will-quit`（服务停止 + `stopKernel` + `logger.finish`），当前没有任何服务需要
 *   动态挂载关机 handler，零注册者的注册表是死表面。
 * - 上游允许 handler 做耗时收尾；fork 版只做日志 + 轻量保存请求，绝不在电源事件
 *   路径上跑全量备份（`BackupManager` 是 zip 全量拷贝，秒级电源预算内不可能完成，
 *   且该文件为 V2 重构冻结面）。fork 的数据安全不依赖关机窗口，见下。
 *
 * 平台覆盖矩阵（Electron 41，`electron.d.ts` 的 @platform 注记）：
 * | 事件     | win32         | darwin          | linux          | 动作                     |
 * |----------|---------------|-----------------|----------------|--------------------------|
 * | suspend  | 派发          | 派发            | 派发           | 日志 + 轻量保存请求      |
 * | resume   | 派发          | 派发            | 派发           | 仅日志（排障取证点）     |
 * | shutdown | 不派发        | 派发（重启/关机）| 派发（会话结束）| 日志 + 轻量保存请求      |
 *
 * 轻量保存请求 = 给主窗口渲染层发 `App_SaveData`（渲染层 `handleSaveData()` flush
 * redux-persist），与 `index.ts` before-quit、`WindowService` 关窗路径是同一原语，
 * 幂等。火后不管：电源事件时刻系统即将冻结全部进程，无法也不应等待渲染层完成；
 * suspend 前的发送属于尽力而为（主进程收到 suspend 通知时渲染层可能已被一并挂起）。
 *
 * Windows 关机缺口的数据安全兜底（不依赖关机钩子）：
 * - 内核会话日志是唯一事实源：sessions.db 为 WAL 模式，崩溃安全，重开折叠恢复
 *   （硬性不变量 #1/#2）。内核不对外提供 checkpoint 缝，主进程不允许直连 SQLite，
 *   故这里不做 WAL checkpoint。
 * - 渲染层 redux-persist 随每次 dispatch 持续写 localStorage。
 * - 应用自身发起的退出（用户手动退出等）走 `index.ts` before-quit/will-quit 的
 *   完整收尾，不受本缺口影响。
 */
class PowerMonitorService {
  private initialized = false

  /**
   * 挂载电源事件监听。必须在 app ready 之后调用（powerMonitor 的前提条件）；
   * 重复调用是幂等 no-op（仅告警）。
   */
  init(): void {
    if (this.initialized) {
      logger.warn('PowerMonitorService already initialized')
      return
    }

    // 'shutdown' 在 win32 上永不派发，监听它无副作用；不按平台分支注册（上游的
    // isWin 分支服务于 electron-shutdown-handler，fork 没有该依赖，统一注册更简单）。
    powerMonitor.on('suspend', () => this.onSuspend())
    powerMonitor.on('resume', () => this.onResume())
    powerMonitor.on('shutdown', () => this.onShutdown())

    this.initialized = true
    logger.info('PowerMonitorService initialized', { platform: process.platform })
  }

  /**
   * 系统即将休眠。休眠后可能断电/电池耗尽而不再有任何关机通知，故仍发一次
   * 轻量保存请求（尽力而为，见文件头说明）。
   */
  private onSuspend(): void {
    logger.info('System suspend detected', { platform: process.platform })
    this.requestLightweightSave('suspend')
  }

  /**
   * 系统从休眠恢复。仅日志：恢复时间戳是排障取证点——活跃流式传输在会话日志
   * dt 数组里的空洞可与系统睡眠窗口对齐（配合 v0.4.6-1 的 streaming stall 取证钩子）。
   */
  private onResume(): void {
    logger.info('System resume detected', { platform: process.platform })
  }

  /**
   * 系统即将重启/关机（仅 linux/darwin 派发）。保持同步轻量：操作系统很快会终止
   * 进程，重量级收尾（子进程杀树、内核停止）属于 `index.ts` before-quit/will-quit
   * 的应用退出路径，这里不重复也不等待。
   */
  private onShutdown(): void {
    logger.info('System shutdown detected', { platform: process.platform })
    this.requestLightweightSave('shutdown')
  }

  /**
   * 请求渲染层做一次轻量保存（App_SaveData → handleSaveData flush redux-persist）。
   * 任何失败只记日志——电源事件路径上没有用户可见信号可用，也不能抛出打断其它监听。
   */
  private requestLightweightSave(reason: 'suspend' | 'shutdown'): void {
    try {
      const mainWindow = windowService.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        logger.warn(`Main window unavailable, skip lightweight save on ${reason}`)
        return
      }
      mainWindow.webContents.send(IpcChannel.App_SaveData)
      logger.info(`Lightweight save requested on ${reason}`)
    } catch (error) {
      logger.warn(`Lightweight save on ${reason} failed`, error as Error)
    }
  }
}

/**
 * Singleton instance of PowerMonitorService
 */
export const powerMonitorService = new PowerMonitorService()
