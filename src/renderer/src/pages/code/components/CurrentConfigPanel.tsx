import { FolderOpen } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from './shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/CurrentConfigPanel.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点两处，工作目录行（只读输入 + 选择按钮）逐字：
// ① terminal 选择 UI 数据面裁掉（useAvailableTerminals 缝注：dsh/hermes 为受管 Web UI，不消费
//   外部终端）——terminals/selectedTerminal/onSelectTerminal props 与 Select 分支不搬。
// ② UI 面缝：@cherrystudio/ui 的 Button/Input → 本页 shim；isMac/isWin 门随 terminal 分支裁剪。

export interface CurrentConfigPanelProps {
  directory?: string
  onSelectFolder: () => void
}

/** Current provider's working-directory + terminal picker. */
export const CurrentConfigPanel: FC<CurrentConfigPanelProps> = ({ directory, onSelectFolder }) => {
  const { t } = useTranslation()

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">{t('code.working_directory')}</label>
        <div className="flex w-full items-center">
          <Input value={directory ?? ''} placeholder={t('code.folder_placeholder')} readOnly tabIndex={-1} />
          <Button variant="default" onClick={onSelectFolder} className="ml-2 shrink-0">
            <FolderOpen size={16} />
            {t('code.select_folder')}
          </Button>
        </div>
      </div>
    </div>
  )
}
