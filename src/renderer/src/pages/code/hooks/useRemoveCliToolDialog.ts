import type { ComponentProps } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ConfirmDialog } from '../components/shadcn'
import type { CodeCli } from '@shared/types/codeCli'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/hooks/useRemoveCliToolDialog.ts
//（2026-09-24，v0.3.4-1 批次4b）。逐字；import 面对号：ConfirmDialog 类型 ← 本页 shim
//（fork 无 @cherrystudio/ui）、CodeCli ← @shared/types/codeCli。

interface RemoveCliToolDialogController {
  removeDialogProps: ComponentProps<typeof ConfirmDialog>
  requestRemove: (tool: CodeCli) => void
}

export function useRemoveCliToolDialog({
  toolName,
  remove
}: {
  toolName: string
  remove: (tool: CodeCli) => Promise<void>
}): RemoveCliToolDialogController {
  const { t } = useTranslation()
  const [removeTarget, setRemoveTarget] = useState<CodeCli | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  return {
    removeDialogProps: {
      open: !!removeTarget,
      onOpenChange: (open) => !open && setRemoveTarget(null),
      title: t('settings.dependencies.uninstallConfirmTitle'),
      description: t('settings.dependencies.uninstallConfirmMessage', { name: toolName }),
      cancelText: t('common.cancel'),
      confirmText: t('common.confirm'),
      destructive: true,
      confirmLoading: isRemoving,
      onConfirm: async () => {
        if (!removeTarget) return

        setIsRemoving(true)
        try {
          await remove(removeTarget)
        } finally {
          setIsRemoving(false)
        }
      }
    },
    requestRemove: setRemoveTarget
  }
}
