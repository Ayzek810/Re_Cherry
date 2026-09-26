import { useEffect, useState } from 'react'

import type { BinaryToolSnapshot } from '@renderer/pages/code/utils/binarySnapshot'
import type { ManagedToolStatusState } from '@shared/types/managedTool'

// fork 缝（批次4a 原创缝 hook，~60 行）：V2 的状态读取走 useSharedCacheValue
//（'feature.deepseek_harness.status' / 'feature.hermes_dashboard.status' / gateway 运行态 /
// binary 快照，主进程共享缓存 + 推送）；fork 无 Cache 层——主进程在批次 1-3 已将同一状态面
// 改为全窗口 onStatus 广播（DeepSeekHarnessService/HermesDashboardService/ApiGatewayService/
// BinaryManager 的 publishStatus），本模块把四个消费点收敛为对号 hook。deepseek/hermes 的
// "立即拉当前值" 由批次 4a 新增的 GetStatus 通道承担（code-cli:*:get-status，订阅前无推送
// 也能拿到当下状态）；binary 快照立即拉取用既有 binary.snapshots()。

/** fork 缝：V2 gateway 运行态载荷（{running, lanRunning, port?}，见 ApiGatewayService.publishRunningState）。 */
export interface ApiGatewayStatusState {
  running: boolean
  lanRunning?: boolean
  port?: number
}

const STOPPED: ManagedToolStatusState = { status: 'stopped' }
const GATEWAY_IDLE: ApiGatewayStatusState = { running: false }

function useManagedToolStatusState(
  getStatus: () => Promise<unknown>,
  onStatus: (callback: (status: unknown) => void) => () => void,
  initial: ManagedToolStatusState
): ManagedToolStatusState {
  const [state, setState] = useState<ManagedToolStatusState>(initial)
  useEffect(() => {
    let cancelled = false
    const apply = (status: unknown) => {
      if (!cancelled && status) setState(status as ManagedToolStatusState)
    }
    void getStatus().then(apply).catch(() => {})
    const unsubscribe = onStatus(apply)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [getStatus, onStatus])
  return state
}

/** DeepSeek Harness 状态（V2 useSharedCacheValue('feature.deepseek_harness.status') 的 fork 对位）。 */
export function useDeepSeekHarnessStatus(): ManagedToolStatusState {
  const { deepseekHarness } = window.api.codeCli
  return useManagedToolStatusState(
    () => deepseekHarness.getStatus(),
    (cb) =>
      deepseekHarness.onStatus((status) => cb(status)),
    STOPPED
  )
}

/** Hermes Dashboard 状态（V2 useSharedCacheValue('feature.hermes_dashboard.status') 的 fork 对位）。 */
export function useHermesDashboardStatus(): ManagedToolStatusState {
  const { hermesDashboard } = window.api.codeCli
  return useManagedToolStatusState(
    () => hermesDashboard.getStatus(),
    (cb) =>
      hermesDashboard.onStatus((status) => cb(status)),
    STOPPED
  )
}

/** 统一网关运行态（V2 useApiGateway 的 running 面的 fork 对位）。 */
export function useApiGatewayStatus(): ApiGatewayStatusState {
  const [state, setState] = useState<ApiGatewayStatusState>(GATEWAY_IDLE)
  useEffect(() => {
    let cancelled = false
    const apply = (status: unknown) => {
      if (!cancelled && status) setState(status as ApiGatewayStatusState)
    }
    void window.api.codeCli.apiGateway.getStatus().then(apply).catch(() => {})
    const unsubscribe = window.api.codeCli.apiGateway.onStatus(apply)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return state
}

/** binary 快照（V2 useSharedCacheValue('feature.code_cli.binaries') 读取面的 fork 对位）。 */
export function useBinarySnapshots(): Record<string, BinaryToolSnapshot> {
  const [snapshots, setSnapshots] = useState<Record<string, BinaryToolSnapshot>>({})
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const next = (await window.api.codeCli.binary.snapshots()) as Record<string, BinaryToolSnapshot>
        if (!cancelled) setSnapshots(next ?? {})
      } catch {
        // 快照读取失败保形为空表（消费方按 resolved=false 的重试语义兜底，见 useCliVersionStatuses）。
      }
    }
    void refresh()
    const unsubscribe = window.api.codeCli.binary.onChanged(() => void refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return snapshots
}
