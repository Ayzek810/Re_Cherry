import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { loggerService } from '@logger'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { CodeCli } from '@shared/types/codeCli'
import type { InstallProgressPayload } from '@shared/types/installProgress'

import { withDetail } from '../utils/errorDetail'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useBinaryActions.ts
//（2026-09-24，v0.3.4-1 批次4b）。缝点三处：
// ① IPC 缝：`ipcApi.request('binary.install_tool', {name, targetVersion?})` → `window.api.
//   codeCli.binary.install(name, targetVersion?)`；`binary.remove_tool` →
//   `window.api.codeCli.binary.remove(name)`。v0.4.5-1（O2）：targetVersion 真的贯通到主进程
//   并钉 spec（此前只是保形入参）。
// ② 结果缝：fork 主进程不抛错，返回结果对象——install 为 {success, message?}（V2 成功无返回/
//   失败靠 throw），remove 为 {removed, message?}（V2 为 {status:'cleanup_blocked'|…, message?}）。
//   remove 的 fail-closed 分态统一收敛为 removed=false（无 blocked/definition-only 对比面）。
// ③ toast 缝：`@renderer/services/toast` → fork `window.toast`；logger 缝：'@logger'。
//   v0.4.5-1：失败不再只是日志——即时 toast（此处）+ 持久失败行（主进程 lastFailure 经快照）。

const logger = loggerService.withContext('useBinaryActions')

/**
 * Per-tool install/upgrade/remove actions. The busy Sets are global (not keyed
 * to the selected tool) so the sidebar can show every tool's install state
 * independently — installing codex must not make the claude-code card flash.
 */
export function useBinaryActions() {
  const { t } = useTranslation()
  const [installingTools, setInstallingTools] = useState<Set<string>>(() => new Set())
  const [upgradingTools, setUpgradingTools] = useState<Set<string>>(() => new Set())
  // v0.3.4-2（用户裁决）：安装步骤进度——主进程每完成一个阶段广播一次，进度条渲染步名。
  // v0.4.5-1：载荷形状与步骤词汇来自 @shared/types/installProgress（主进程、preload 桥、
  // 渲染层同一份契约）；detail 是下载字节进度、fraction 是进度条本体的确定性比例。
  const [installProgress, setInstallProgress] = useState<InstallProgressPayload | null>(null)
  useEffect(() => {
    const unsubscribe = window.api.codeCli.binary.onInstallProgress((payload) => setInstallProgress(payload))
    return unsubscribe
  }, [])

  // install and upgrade share one body — both run the same name-only
  // `binary.install_tool` request; main resolves the Code CLI's fixed recipe
  // itself. They differ only in the busy Set, the success toast, and the log
  // label. Failures are not toasted here: the main process tracks them in the
  // install-state map and the version card renders a persistent failure row.
  const runInstallTool = useCallback(
    async (
      toolId: CodeCli,
      setBusy: Dispatch<SetStateAction<Set<string>>>,
      messages: { successKey: string; logLabel: string },
      targetVersion?: string
    ) => {
      // v0.4.5-1（O2）：targetVersion 真的传下去了——"检查到 A 却装了 B"是通道 tag 漂移下的
      // 常态（此前这里 `void targetVersion`，入参只是保形）。
      try {
        setBusy((prev) => new Set(prev).add(toolId))
        // fork 缝①：V2 为 `await ipcApi.request('binary.install_tool', {name, …})`。
        const result = (await window.api.codeCli.binary.install(
          CODE_CLI_TOOL_PRESET_MAP[toolId].executable,
          targetVersion
        )) as {
          success: boolean
          message?: string
        }
        if (result.success) {
          window.toast.success(t(messages.successKey))
        } else {
          // v0.4.5-1（真机反馈的静默失败）：主进程把失败原因（已 redactSecretText 清洗，
          // 含 pnpm ERR_PNPM_* 与"市场基线装不上"这类结论）随结果返回，此前只写日志——
          // 用户点安装看到的是"什么都没发生"。这里是即时信号；持久显示由主进程记录的
          // lastFailure（随快照下发）经版本卡的失败行承担。
          logger.error(messages.logLabel, new Error(result.message ?? 'install failed'))
          window.toast.error(withDetail(t('code.install_failed'), result.message))
        }
      } catch (error) {
        logger.error(messages.logLabel, error as Error)
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(toolId)
          return next
        })
        // v0.4.5-1（O6）：本次尝试结束即清掉进度快照——否则切到别的工具再切回来，
        // 会看到上一轮残留的步骤名（"正在构建前端…"）挂在一个没在安装的工具上。
        setInstallProgress((prev) => (prev && prev.tool === CODE_CLI_TOOL_PRESET_MAP[toolId].executable ? null : prev))
      }
    },
    [t]
  )

  // `targetVersion` is only supplied when retrying a failed one-shot update, so
  // the retry repeats the same targeted install instead of a name-only no-op.
  // fork 缝②（续）：fork 无 operation 失败面，消费方不再传 targetVersion；参数形状保留。
  const install = useCallback(
    (toolId: CodeCli, targetVersion?: string) =>
      runInstallTool(
        toolId,
        setInstallingTools,
        {
          successKey: 'code.install_success',
          logLabel: 'Failed to install:'
        },
        targetVersion
      ),
    [runInstallTool]
  )

  const upgrade = useCallback(
    (toolId: CodeCli, latestVersion?: string) =>
      runInstallTool(
        toolId,
        setUpgradingTools,
        {
          successKey: 'code.upgrade_success',
          logLabel: 'Failed to upgrade:'
        },
        latestVersion
      ),
    [runInstallTool]
  )

  const remove = useCallback(
    async (toolId: CodeCli): Promise<boolean> => {
      try {
        // fork 缝①：V2 为 `await ipcApi.request('binary.remove_tool', {name})`。
        const result = (await window.api.codeCli.binary.remove(CODE_CLI_TOOL_PRESET_MAP[toolId].executable)) as {
          removed: boolean
          message?: string
        }
        // A Code CLI is a fixed tool: it has no removable definition, so a
        // fail-closed cleanup_blocked has no definition-only fallback — surface it
        // as an error the user resolves (e.g. stop a dependent) before retrying.
        // fork 缝②（续）：失败分态收敛为 removed=false。
        if (!result.removed) {
          window.toast.error(result.message ?? t('settings.dependencies.uninstallFailed'))
          return false
        }
        window.toast.success(t('settings.dependencies.uninstallSuccess'))
        return true
      } catch (error) {
        logger.error('Failed to remove:', error as Error)
        window.toast.error(t('settings.dependencies.uninstallFailed'))
        return false
      }
    },
    [t]
  )

  return {
    install,
    upgrade,
    remove,
    installingTools,
    upgradingTools,
    installProgress
  }
}
