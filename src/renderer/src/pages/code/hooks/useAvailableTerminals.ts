import { useEffect, useState } from 'react'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useAvailableTerminals.ts
//（2026-09-24，v0.3.4-1 批次4b）。fork 缝（整体 stub）：`code_cli.get_available_terminals`
// 主进程面不存在（外部终端启动面未接——dsh/hermes 为受管 Web UI，不消费外部终端；
// 保留工具的启动经 deepseekHarness/hermesDashboard 通道分流）。hook 保留形状、返回常量空数组，
// 消费方（useLaunchDialogController/CurrentConfigPanel/LaunchDialog）的 terminal 选择 UI 数据面
// 随批次 4b 一并裁掉；主进程接入时按 V2 原文（isMac/isWin 门 + IPC 读表）回填。

/** fork 缝：V2 的 TerminalConfig 位于 @shared/types/codeCli（fork 未移植该 shared 面）。 */
export interface TerminalConfig {
  id: string
  name: string
}

/**
 * Available terminal apps (macOS/Windows only). Loaded once on mount; returns
 * an empty list on Linux or on fetch failure.
 */
export function useAvailableTerminals(): TerminalConfig[] {
  const [terminals, setTerminals] = useState<TerminalConfig[]>([])

  useEffect(() => {
    // fork 缝（续）：主进程读表面未接，恒为空集；保留 setState 形状便于回填。
    setTerminals([])
  }, [])

  return terminals
}
