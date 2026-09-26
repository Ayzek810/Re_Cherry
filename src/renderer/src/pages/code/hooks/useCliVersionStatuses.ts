import { useEffect, useMemo, useRef, useState } from 'react'

import { loggerService } from '@logger'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { CodeCli } from '@shared/types/codeCli'

import { interpretBinarySnapshot, type BinaryToolSnapshot } from '../utils/binarySnapshot'
import type { VersionStatus } from '../types'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useCliVersionStatuses.ts
//（2026-09-24，v0.3.4-1 批次4a）。缝点三处，其余（重试/版本缓存/latestRef 数据流）逐字：
// ① IPC 缝：`ipcApi.request('binary.get_tool_snapshots', names)` → `window.api.codeCli.binary.
//   snapshots()`（fork 主进程白名单固定 ['dsh','hermes']，与工具集等价）；`binary.get_latest_versions
//   (refresh)` → `window.api.codeCli.binary.latestVersions()`（fork 无 refresh 形参——主进程
//   每次调用都现查，V2 的冷缓存两段式读取收敛为一次调用）；`useIpcOn('binary.availability_changed')`
//   → `window.api.codeCli.binary.onChanged(cb)`。
// ② 快照形状缝：fork 快照为 V2 子集（application 扁平状态串，无 operation 广播面——
//   BinaryManager 抄形状注释），`application?.status` → `application`，operation 臂不保留。
// ③ logger/toast 缝：import 对号。

const logger = loggerService.withContext('useCliVersionStatus')

const buildStatus = (snapshot: BinaryToolSnapshot | undefined, latest?: string): VersionStatus => {
  const view = interpretBinarySnapshot(snapshot, { latest })
  return {
    installed: view.installed,
    source: view.source,
    // Backend-application fact drives update/uninstall/repair authority; a fixed
    // CLI's identity comes from the preset, so it carries no custom definition.
    ...(view.applicationStatus ? { applicationStatus: view.applicationStatus } : {}),
    ...(view.installedVersion !== undefined ? { current: view.installedVersion } : {}),
    ...(view.source === 'managed' ? { latest } : {}),
    ...(view.systemPath !== undefined ? { systemPath: view.systemPath } : {}),
    canUpgrade: view.hasUpdate
  }
}

const SNAPSHOT_RETRY_MS = 2000
const SNAPSHOT_MAX_ATTEMPTS = 5

export interface CliVersionStatusesState {
  statuses: Record<string, VersionStatus>
  /** False until a read settles — either successfully or at the retry cap. */
  resolved: boolean
}

/** Availability and managed upgrade status for every CLI tool. */
export const useCliVersionStatuses = (toolIds: readonly CodeCli[]): CliVersionStatusesState => {
  const [statuses, setStatuses] = useState<Record<string, VersionStatus>>({})
  const [resolved, setResolved] = useState(false)
  const [availabilityRevision, setAvailabilityRevision] = useState(0)
  const latestRef = useRef<Record<string, string | undefined>>({})
  const toolKey = toolIds.join('|')
  const tools = useMemo(() => (toolKey ? (toolKey.split('|') as CodeCli[]) : []), [toolKey])

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const refresh = async () => {
      // fork 缝①：V2 为 `await ipcApi.request('binary.get_tool_snapshots', binaryNames)`。
      const snapshots = await window.api.codeCli.binary
        .snapshots()
        .then((result) => result as Record<string, BinaryToolSnapshot>)
        .catch((error) => {
          logger.error('Failed to get CLI tool snapshots', error as Error)
          return null
        })
      if (cancelled) return
      if (!snapshots) {
        // Only an install/remove event re-runs this read, so without a retry a first
        // attempt that races main-process readiness strands every tool for the session.
        attempts += 1
        if (attempts < SNAPSHOT_MAX_ATTEMPTS) retryTimer = setTimeout(() => void refresh(), SNAPSHOT_RETRY_MS)
        else setResolved(true)
        return
      }

      for (const toolId of tools) {
        // Latest applies only to an exactly-applied fixed snapshot — driven by the
        // live application fact, not a custom definition (a fixed CLI carries none).
        if (snapshots[CODE_CLI_TOOL_PRESET_MAP[toolId].executable]?.application !== 'applied') {
          delete latestRef.current[toolId]
        }
      }
      const hasAppliedCli = tools.some(
        (toolId) => snapshots[CODE_CLI_TOOL_PRESET_MAP[toolId].executable]?.application === 'applied'
      )
      // fork 缝①：V2 先读缓存（refresh=false）再按需强取（refresh=true）两段式；fork 的
      // latestVersions() 每次现查，收敛为一次调用。
      let latestVersions: Record<string, string | undefined> = {}
      if (hasAppliedCli) {
        latestVersions = (await window.api.codeCli.binary.latestVersions().catch((error) => {
          logger.error('Failed to get latest binary versions', error as Error)
          return {}
        })) as Record<string, string | undefined>
      }
      if (cancelled) return

      const next: Record<string, VersionStatus> = {}
      for (const toolId of tools) {
        const binaryName = CODE_CLI_TOOL_PRESET_MAP[toolId].executable
        const latest = latestVersions[binaryName] ?? latestRef.current[toolId]
        latestRef.current[toolId] = latest
        next[toolId] = buildStatus(snapshots[binaryName], latest)
      }
      setStatuses(next)
      setResolved(true)
    }

    void refresh()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [availabilityRevision, toolKey, tools])

  // fork 缝①：V2 为 `useIpcOn('binary.availability_changed', …)`。
  useEffect(() => {
    const unsubscribe = window.api.codeCli.binary.onChanged(() => {
      setAvailabilityRevision((revision) => revision + 1)
    })
    return unsubscribe
  }, [])

  return { statuses, resolved }
}
