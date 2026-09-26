import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './shadcn'

import { CurrentConfigPanel } from './CurrentConfigPanel'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/LaunchDialog.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点两处，对话框骨架（标题/CurrentConfigPanel/取消-启动脚位）逐字：
// ① terminal 选择数据面裁掉（useAvailableTerminals 缝注）——terminals/selectedTerminal/
//   onSelectTerminal props 不搬。
// ② UI 面缝：@cherrystudio/ui Dialog 族/Button → 本页 shim（antd Modal）。
// 该对话框对保留工具（dsh/hermes）为 dormant 面：onLaunch 由 deepseekHarness/hermesDashboard
// 通道分流（见 useCodeCliPageViewProps 缝注），code_cli.run 臂未接。

export interface LaunchDialogProps {
  open: boolean
  onClose: () => void
  toolName: string
  directory?: string
  onSelectFolder: () => void
  onLaunch: () => void
  launching: boolean
}

export const LaunchDialog: FC<LaunchDialogProps> = ({
  open,
  onClose,
  toolName,
  directory,
  onSelectFolder,
  onLaunch,
  launching
}) => {
  const { t } = useTranslation()
  const canLaunch = !!directory

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent size="default" aria-describedby={undefined} className="flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('code.launch.title', { tool: toolName })}</DialogTitle>
        </DialogHeader>

        <CurrentConfigPanel directory={directory} onSelectFolder={onSelectFolder} />

        <DialogFooter className="justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={launching}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" size="sm" onClick={onLaunch} disabled={!canLaunch || launching} loading={launching}>
            {t('code.launch.label')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
