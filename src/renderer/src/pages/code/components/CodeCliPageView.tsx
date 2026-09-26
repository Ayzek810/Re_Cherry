import type { ComponentProps, FC } from 'react'
import { Fragment } from 'react'

import { ConfirmDialog } from './shadcn'

import { CodeCliContentPanel } from './CodeCliContentPanel'
import { CodeCliSidebar } from './CodeCliSidebar'
import { ConfigEditPanel } from './configEditPanel/ConfigEditPanel'
import { OwnLoginConfigPanel } from './configEditPanel/OwnLoginConfigPanel'
import { LaunchDialog } from './LaunchDialog'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/CodeCliPageView.tsx
//（2026-09-24，v0.3.4-1 批次4b）。逐字；import 面对号：ConfirmDialog ← 本页 shim，
// CodeCliContentPanel/CodeCliSidebar/LaunchDialog/ConfigEditPanel/OwnLoginConfigPanel ← 本页移植件。

export interface CodeCliPageViewProps {
  sidebarProps: ComponentProps<typeof CodeCliSidebar>
  contentProps?: ComponentProps<typeof CodeCliContentPanel>
  emptyMessage: string
  launchDialogProps: ComponentProps<typeof LaunchDialog>
  removeDialogProps: ComponentProps<typeof ConfirmDialog>
  configPanelKey?: string
  configPanelProps?: ComponentProps<typeof ConfigEditPanel>
  ownLoginConfigPanelProps?: ComponentProps<typeof OwnLoginConfigPanel>
}

export const CodeCliPageView: FC<CodeCliPageViewProps> = ({
  sidebarProps,
  contentProps,
  emptyMessage,
  launchDialogProps,
  removeDialogProps,
  configPanelKey,
  configPanelProps,
  ownLoginConfigPanelProps
}) => {
  return (
    <div data-ui="code.view" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden text-foreground">
      <div className="flex min-h-0 flex-1">
        <CodeCliSidebar {...sidebarProps} />

        <div data-ui="code.content" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {contentProps ? (
            <CodeCliContentPanel {...contentProps} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-foreground-tertiary">
              {emptyMessage}
            </div>
          )}
        </div>
      </div>

      <LaunchDialog {...launchDialogProps} />
      <ConfirmDialog {...removeDialogProps} />
      {configPanelProps && (
        <Fragment key={configPanelKey}>
          <ConfigEditPanel {...configPanelProps} />
        </Fragment>
      )}
      {ownLoginConfigPanelProps && (
        <Fragment key={configPanelKey}>
          <OwnLoginConfigPanel {...ownLoginConfigPanelProps} />
        </Fragment>
      )}
    </div>
  )
}
