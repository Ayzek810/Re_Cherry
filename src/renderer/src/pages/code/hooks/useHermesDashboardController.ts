import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { CodeCli } from '@shared/types/codeCli'

import { useHermesDashboardStatus } from './useCodeCliStatus'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useHermesDashboardController.ts
//（2026-09-24，v0.3.4-1 批次4a）。缝点四处，函数体逐字：
// ① 状态缝：useSharedCacheValue('feature.hermes_dashboard.status') → useHermesDashboardStatus()
//   （useCodeCliStatus 订阅缝）。
// ② 弹窗缝：openSmartMiniApp → openSmartMinapp（同 useDeepSeekHarnessController 缝①；id 用
//   'code-mate-hermes'，logo 省略——V2 'nousresearch' 为 V2 图标注册表键）。
// ③ IPC 缝：`ipcApi.request('hermes_dashboard.start'|'.stop')` → `window.api.codeCli.
//   hermesDashboard.start|stop`（start 无入参，V2 zod schema 为 z.void()）。
// ④ 类型缝：HermesDashboardStartFailureReason 在 V2 位于 @shared/ipc/schemas/hermesDashboard.ts
//   （zod 路由层不搬）；fork 主进程 HermesDashboardService 已定义同值联合，渲染层不可 import
//   @main——此处按 V2 schema 原文逐字落盘。
// ⑤ toast 缝：`@renderer/services/toast` → fork `window.toast`；logger 缝：'@logger'。

const logger = loggerService.withContext('useHermesDashboardController')
const ERROR_DETAIL_LIMIT = 200

// fork 缝④：V2 src/shared/ipc/schemas/hermesDashboard.ts HERMES_DASHBOARD_START_FAILURE_REASONS 逐字。
export const HERMES_DASHBOARD_START_FAILURE_REASONS = [
  'not_installed',
  'dashboard_dependencies_missing',
  'cancelled',
  'startup_failed'
] as const
export type HermesDashboardStartFailureReason = (typeof HERMES_DASHBOARD_START_FAILURE_REASONS)[number]

const START_ERROR_KEYS: Record<HermesDashboardStartFailureReason, string> = {
  cancelled: 'code.hermes_dashboard.error.cancelled',
  dashboard_dependencies_missing: 'code.hermes_dashboard.error.dependencies_missing',
  not_installed: 'code.hermes_dashboard.error.not_installed',
  startup_failed: 'code.hermes_dashboard.error.startup_failed'
}

function withDetail(title: string, detail: string | undefined): string {
  const trimmed = detail?.trim()
  return trimmed ? `${title}: ${trimmed.slice(0, ERROR_DETAIL_LIMIT)}` : title
}

interface HermesDashboardControllerOptions {
  onConfigMayHaveChanged?: () => void
}

interface HermesDashboardController {
  launching: boolean
  running: boolean
  starting: boolean
  stopping: boolean
  onLaunch: () => Promise<void>
  onOpenDashboard: () => Promise<void>
  onStop: () => Promise<boolean>
}

export function useHermesDashboardController(
  selectedCliTool: CodeCli,
  { onConfigMayHaveChanged }: HermesDashboardControllerOptions = {}
): HermesDashboardController {
  const { t } = useTranslation()
  const { openSmartMinapp } = useMinappPopup()
  // fork 缝①：V2 为 `useSharedCacheValue('feature.hermes_dashboard.status') ?? { status: 'stopped' as const }`。
  const snapshot = useHermesDashboardStatus() ?? { status: 'stopped' as const }
  const previousStatus = useRef(snapshot.status)
  const operationEpoch = useRef(0)
  const [pendingOperation, setPendingOperation] = useState<'launch' | 'stop' | null>(null)
  const isHermes = selectedCliTool === CodeCli.HERMES

  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = snapshot.status
    if (
      (previous === 'running' && (snapshot.status === 'stopped' || snapshot.status === 'error')) ||
      (previous === 'starting' && snapshot.status === 'error')
    ) {
      onConfigMayHaveChanged?.()
    }
  }, [onConfigMayHaveChanged, snapshot.status])

  const openDashboard = useCallback(
    (dashboardUrl: string) => {
      const target = new URL(dashboardUrl)
      target.searchParams.set('cherry_navigation_revision', String(Date.now()))
      openSmartMinapp({
        id: 'code-mate-hermes',
        name: t('code.cli_tools.hermes'),
        url: target.toString()
      })
    },
    [openSmartMinapp, t]
  )

  const onLaunch = useCallback(async () => {
    const epoch = ++operationEpoch.current
    setPendingOperation('launch')
    try {
      // fork 缝③：V2 为 `await ipcApi.request('hermes_dashboard.start')`。
      const result = (await window.api.codeCli.hermesDashboard.start()) as
        | { success: true; url: string }
        | { success: false; reason: HermesDashboardStartFailureReason; message: string }
      if (epoch !== operationEpoch.current) return
      if (!result.success) {
        previousStatus.current = 'error'
        onConfigMayHaveChanged?.()
        logger.error('Failed to launch Hermes Dashboard', new Error(result.message), { reason: result.reason })
        window.toast.error(withDetail(t(START_ERROR_KEYS[result.reason]), result.message))
        return
      }
      openDashboard(result.url)
    } catch (error) {
      logger.error('Failed to launch Hermes Dashboard', error as Error)
      window.toast.error(t(START_ERROR_KEYS.startup_failed))
    } finally {
      if (epoch === operationEpoch.current) setPendingOperation(null)
    }
  }, [onConfigMayHaveChanged, openDashboard, t])

  const onStop = useCallback(async () => {
    const epoch = ++operationEpoch.current
    setPendingOperation('stop')
    try {
      // fork 缝③：V2 为 `await ipcApi.request('hermes_dashboard.stop')`。
      const result = (await window.api.codeCli.hermesDashboard.stop()) as { success: boolean; message?: string }
      if (epoch !== operationEpoch.current) return false
      if (!result.success) {
        logger.error('Failed to stop Hermes Dashboard', new Error(result.message))
        window.toast.error(withDetail(t('code.hermes_dashboard.error.stop_failed'), result.message))
        return false
      }
      previousStatus.current = 'stopped'
      onConfigMayHaveChanged?.()
      return true
    } catch (error) {
      logger.error('Failed to stop Hermes Dashboard', error as Error)
      window.toast.error(t('code.hermes_dashboard.error.stop_failed'))
      return false
    } finally {
      if (epoch === operationEpoch.current) setPendingOperation(null)
    }
  }, [onConfigMayHaveChanged, t])

  const onOpenDashboard = useCallback(async () => {
    if (snapshot.status === 'running' && snapshot.url) {
      openDashboard(snapshot.url)
      return
    }
    logger.error('Failed to open Hermes Dashboard', new Error('Hermes Dashboard is not running'))
    window.toast.error(t('code.hermes_dashboard.error.open_failed'))
  }, [openDashboard, snapshot.status, snapshot.url, t])

  return {
    launching: isHermes && pendingOperation === 'launch',
    running: isHermes && snapshot.status === 'running',
    starting: isHermes && snapshot.status === 'starting',
    stopping: isHermes && pendingOperation === 'stop',
    onLaunch,
    onOpenDashboard,
    onStop
  }
}
