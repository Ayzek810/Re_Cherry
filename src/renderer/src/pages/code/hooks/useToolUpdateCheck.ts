import { loggerService } from '@logger'
import { CODE_CLI_TOOL_PRESET_MAP } from '@shared/data/presets/codeCliTools'
import type { CodeCli } from '@shared/types/codeCli'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { withDetail } from '../utils/errorDetail'

// （fork 原创）：手动"检查更新"。
// 与挂载时自动查询（useCliVersionStatuses → latestVersions）的分工：
// ① 自动通道只覆盖注册表型工具（npm/PyPI）的"最新版本"展示；paper-agent 不在其中——它的
//    上游查询是 GitHub API，纯手动（见 BinaryManager.getLatestVersions 的纸面策略）。
// ② 本 hook 的按钮通道对三个工具一律生效，并且是**强制重探**（绕过快照 15s 冷却）——语义
//    是"现在就看一眼"，因此结论与版本卡展示的当前版本必定同源同时刻。
// 结论按 executable 存表，由装配点（useCodeCliPageViewProps）注入到选中工具的 versionStatus。

const logger = loggerService.withContext('useToolUpdateCheck')

type CheckUpdatesResult =
  | {
      success: true
      /** （）：解析到的安装来源；只有 managed 才谈得上"本应用可升级"。 */
      source: 'managed' | 'system' | 'none'
      current?: string
      latest?: string
      canUpgrade: boolean
    }
  | { success: false; message: string }

export interface ToolUpdateCheckResult {
  /** （）：结论的适用面——装配点只在 managed 时把它注入版本卡。 */
  source: 'managed' | 'system' | 'none'
  latest?: string
  canUpgrade: boolean
  /**
   * 该结论所针对的"当前版本"。装配点只在它与快照里的当前版本一致时才注入结论——
   * 装/升级完成后当前版本已变，旧结论自动失效（无需订阅清除，也没有广播竞态）。
   */
  forVersion?: string
}

export interface ToolUpdateCheckState {
  /** 正在检查的工具（executable），按钮据此进入旋转态。 */
  checkingTools: Set<string>
  /** 最近一次手动检查的结论（executable → 结论）；未检查过的工具无键。 */
  results: Record<string, ToolUpdateCheckResult>
  checkForUpdates: (toolId: CodeCli) => Promise<void>
}

export function useToolUpdateCheck(): ToolUpdateCheckState {
  const { t } = useTranslation()
  const [checkingTools, setCheckingTools] = useState<Set<string>>(() => new Set())
  const [results, setResults] = useState<Record<string, ToolUpdateCheckResult>>({})
  // 同工具重复点击的同步闸门（state 更新到下一次渲染之前拦不住连点）。
  const inFlight = useRef<Set<string>>(new Set())

  const checkForUpdates = useCallback(
    async (toolId: CodeCli) => {
      const executable = CODE_CLI_TOOL_PRESET_MAP[toolId].executable
      if (inFlight.current.has(executable)) return
      inFlight.current.add(executable)
      setCheckingTools((prev) => new Set(prev).add(executable))
      try {
        const result = (await window.api.codeCli.binary.checkUpdates(executable)) as CheckUpdatesResult
        if (!result.success) {
          logger.error('Failed to check for updates:', new Error(result.message), { tool: executable })
          window.toast.error(withDetail(t('code.check_updates_failed'), result.message))
          return
        }
        setResults((prev) => ({
          ...prev,
          [executable]: {
            source: result.source,
            latest: result.latest,
            canUpgrade: result.canUpgrade,
            ...(result.current ? { forVersion: result.current } : {})
          }
        }))
        // （）：非受管安装不说"版本"——系统来源的工具本应用既不知道它的版本也
        // 升不了它，回一句"已是最新版本"是假陈述（这正是用户会照做的错误结论）。
        if (result.source === 'system') {
          window.toast.info(t('code.check_updates_system'))
        } else if (result.source === 'none') {
          window.toast.info(t('code.check_updates_not_installed'))
        } else if (result.canUpgrade) {
          window.toast.success(t('code.update_found', { version: result.latest ?? '' }))
        } else {
          window.toast.success(t('code.check_updates_latest'))
        }
      } catch (error) {
        logger.error('Failed to check for updates:', error as Error, { tool: executable })
        window.toast.error(t('code.check_updates_failed'))
      } finally {
        inFlight.current.delete(executable)
        setCheckingTools((prev) => {
          const next = new Set(prev)
          next.delete(executable)
          return next
        })
      }
    },
    [t]
  )

  return { checkingTools, results, checkForUpdates }
}
