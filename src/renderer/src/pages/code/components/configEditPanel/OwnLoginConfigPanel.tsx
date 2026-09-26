import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../shadcn'
import { CliIcon } from '../CliIcon'
import { SettingContainer, SettingGroup, SettingTitle } from '../SettingsPrimitives'
import { loggerService } from '@logger'
import { CLI_OWN_LOGIN_PROVIDER_ID } from '@shared/types/codeCli'

import {
  type CliConfigFileDraft,
  readOwnLoginCliConfigDraft,
  sanitizeCliConfigBlob,
  validateCliConfigDraftForWrite
} from '@renderer/pages/code/cliConfig'

import { AdvancedConfigToggle } from './AdvancedConfigToggle'
import { CliConfigEditor } from './CliConfigEditor'
import { renderToolFields } from './toolFieldRenderer'
import type { OwnLoginConfigPanelProps } from './types'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/
// OwnLoginConfigPanel.tsx（2026-09-24，v0.3.4-1 批次4b）。缝点三处，受管/原文两态与保存门逐字：
// ① Props 缝：OwnLoginConfigPanelProps 自 fork 4a 前移的 ./types 引用（4a 缝注：V2 定义在本
//   UI 件，4a 前移至 types，4b 挂组件时回指）并 re-export 对齐消费点。
// ② 主题缝：useTheme/SettingContainer 的 theme 面不搬（见 SettingsPrimitives 缝）。
// ③ toast 缝：`@renderer/services/toast` → fork window.toast；UI 面对号（Dialog 族/CliIcon/
//   SettingsPrimitives ← 本页移植件与 shim）。
// fork 面注：own-login 消费点在 fork 为不可达面（LOGIN_CAPABLE_CLI_TOOLS 空集，4a
// useConfigPanelController 缝④），组件按形状移植保留。

const logger = loggerService.withContext('OwnLoginConfigPanel')

export type { OwnLoginConfigPanelProps } from './types'

/** Config panel for the virtual "own login" entry: tool params (permission mode
 * / effort / toggles) plus an advanced raw-config editor, but no model selection
 * or credentials. Persists the blob to the tool preference and, when own login is
 * active, re-applies it to the CLI config file (see useConfigPanelController). */
export const OwnLoginConfigPanel: FC<OwnLoginConfigPanelProps> = ({
  onClose,
  cliTool,
  toolName,
  providerConfig,
  onSubmit
}) => {
  const { t } = useTranslation()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const initialConfig = useMemo(
    () => sanitizeCliConfigBlob(cliTool, providerConfig?.config ?? {}),
    [cliTool, providerConfig]
  )

  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig)
  const [files, setFiles] = useState<CliConfigFileDraft[]>([])
  // 'managed': files are rebuilt from the tool params. 'raw': the user hand-edited settings.json.
  const [mode, setMode] = useState<'managed' | 'raw'>('managed')
  const [error, setError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const loadIdRef = useRef(0)

  // Build the raw settings preview from the saved tool params once the dialog mounts.
  useEffect(() => {
    const loadId = ++loadIdRef.current
    void readOwnLoginCliConfigDraft({ cliTool, configBlob: initialConfig })
      .then((loadedFiles) => {
        if (loadId !== loadIdRef.current) return
        setFiles(loadedFiles)
      })
      .catch((err) => logger.error('Failed to build own-login config preview', err as Error))
  }, [cliTool, initialConfig])

  // Tool-param edit → rebuild the managed preview from the new config.
  const handleConfigChange = useCallback(
    (next: Record<string, unknown>) => {
      const sanitized = sanitizeCliConfigBlob(cliTool, next)
      setConfig(sanitized)
      setMode('managed')
      setError('')
      const loadId = ++loadIdRef.current
      void readOwnLoginCliConfigDraft({ cliTool, configBlob: sanitized })
        .then((nextFiles) => {
          if (loadId !== loadIdRef.current) return
          setFiles(nextFiles)
        })
        .catch((err) => logger.error('Failed to rebuild own-login config preview', err as Error))
    },
    [cliTool]
  )

  // Raw editor edit → take the hand-edited files verbatim on save.
  const handleFilesChange = useCallback((nextFiles: CliConfigFileDraft[]) => {
    try {
      validateCliConfigDraftForWrite(nextFiles)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setFiles(nextFiles)
    setMode('raw')
  }, [])

  // Dirty when the tool params changed, or the user hand-edited the raw file — the async preview
  // itself never counts, so save never depends on the initial load completing first.
  const isConfigDirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(initialConfig), [config, initialConfig])
  const canSave = (isConfigDirty || mode === 'raw') && !error

  const handleSubmit = useCallback(async () => {
    if (!canSave || submitting) return
    try {
      setSubmitting(true)
      await onSubmit({ config, cliConfigFiles: mode === 'raw' ? files : undefined })
      onClose()
    } catch (err) {
      // Keep the dialog open so the user's edits survive a failed apply.
      logger.error('Failed to save own-login config', err as Error)
      window.toast.error(t('code.apply_failed'))
    } finally {
      setSubmitting(false)
    }
  }, [canSave, submitting, config, files, mode, onSubmit, onClose, t])

  const toolFields = renderToolFields({
    cliTool,
    config,
    onChange: handleConfigChange,
    section: 'basic',
    // The basic section renders no model selectors, so provider/model context is unused here.
    providerId: CLI_OWN_LOGIN_PROVIDER_ID,
    modelFilter: () => true
  })

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent
        size="lg"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelButtonRef.current?.focus({ preventScroll: true })
        }}
        className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <CliIcon id={cliTool} size={22} className="size-[22px] shrink-0 rounded-md border border-border-subtle" />
            <span className="min-w-0 truncate">{t('code.own_login.title', { toolName })}</span>
          </DialogTitle>
        </DialogHeader>

        <SettingContainer className="gap-5 p-0">
          <SettingGroup variant="plain" className="border-t-0 pt-0">
            <SettingTitle className="mb-2.5">{t('code.tool_parameters')}</SettingTitle>
            {toolFields}
          </SettingGroup>
          {files.length > 0 && (
            <SettingGroup variant="plain" className="border-t-0 pt-0">
              <AdvancedConfigToggle open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)}>
                <CliConfigEditor files={files} error={error} onChange={handleFilesChange} />
              </AdvancedConfigToggle>
            </SettingGroup>
          )}
        </SettingContainer>

        <DialogFooter className="justify-end gap-2">
          <Button ref={cancelButtonRef} variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" size="sm" onClick={handleSubmit} disabled={!canSave} loading={submitting}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
