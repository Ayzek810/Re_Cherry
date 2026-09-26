import { ExternalLink } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { getProviderLogo } from '@renderer/config/providers'
import { ProviderAvatarPrimitive } from '@renderer/components/ProviderAvatar'
import type { CliConfigFileDraft } from '@renderer/pages/code/cliConfig'
import { isApiGatewayProviderId } from '@shared/types/codeCli'

import type { Provider } from '../../cliConfig/providerView'
import { AdvancedConfigToggle } from './AdvancedConfigToggle'
import { CliConfigEditor } from './CliConfigEditor'
import { SettingContainer, SettingGroup, SettingTitle } from '../SettingsPrimitives'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, GatewayIcon } from '../shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/
// ConfigEditDialogBody.tsx（2026-09-24，v0.3.4-1 批次4b）。缝点四处，对话框骨架（标题行/三段
// SettingGroup/取消-保存脚位）逐字：
// ① 头像缝：V2 GatewayIcon/ProviderAvatarPrimitive logo ReactNode 面 → fork ProviderAvatarPrimitive
//   logoSrc 面 + getProviderLogo 位图资产（无命中回落 ProviderAvatarPrimitive 的首字母块，
//   替代 V2 的 avatar-fallback 槽；`**:data-[slot=…]` 深选择器随 fork 无该 slot 面裁掉）。
// ② Claude 臂删除：isClaudeTool/claudeModelMode/SegmentedControl 段随 claudeModels.ts 未移植裁剪。
// ③ 导航缝：openSettingsTab → fork window.navigate（同路径深链，见 CodeCliContentPanel 缝②）。
// ④ UI 面缝：Dialog 族/Button → 本页 shim；SettingContainer 族 → 本页移植件（theme 面不搬）。

export interface ConfigEditDialogBodyProps {
  open: boolean
  onClose: () => void
  provider: Provider
  providerName: string
  /** Settings route opened from the header link (real provider page, or the gateway settings page). */
  providerSettingsPath: `/settings/${string}`
  modelSectionSlot: ReactNode
  toolFields: ReactNode
  advancedFields: ReactNode
  hasAdvancedSection: boolean
  advancedOpen: boolean
  onAdvancedToggle: () => void
  files: CliConfigFileDraft[]
  error?: string
  onFilesChange: (files: CliConfigFileDraft[]) => void
  submitting: boolean
  canSave: boolean
  onSubmit: () => void
}

export const ConfigEditDialogBody: FC<ConfigEditDialogBodyProps> = ({
  open,
  onClose,
  provider,
  providerName,
  providerSettingsPath,
  modelSectionSlot,
  toolFields,
  advancedFields,
  hasAdvancedSection,
  advancedOpen,
  onAdvancedToggle,
  files,
  error,
  onFilesChange,
  submitting,
  canSave,
  onSubmit
}) => {
  const { t } = useTranslation()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
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
            {isApiGatewayProviderId(provider.id) ? (
              // Match the gateway list card: a broadcast-tower glyph (relay/hub metaphor).
              <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md border border-border-subtle bg-background text-foreground">
                <GatewayIcon width={14} height={14} />
              </span>
            ) : (
              <ProviderAvatarPrimitive
                providerId={provider.id}
                providerName={providerName}
                logoSrc={getProviderLogo(provider.id)}
                size={22}
                className="shrink-0 rounded-md border border-border-subtle"
              />
            )}
            <span className="min-w-0 truncate">{providerName}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('code.open_provider_settings')}
              title={t('code.open_provider_settings')}
              onClick={() => {
                onClose()
                window.navigate(providerSettingsPath)
              }}>
              <ExternalLink className="size-3.5" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        <SettingContainer className="gap-5 p-0">
          <SettingGroup variant="plain" className="border-t-0 pt-0">
            <div className="mb-2.5 flex min-w-0 items-center justify-between gap-3">
              <SettingTitle className="mb-0 min-w-0">{t('code.model_selection')}</SettingTitle>
            </div>
            {modelSectionSlot}
          </SettingGroup>
          {toolFields && (
            <SettingGroup variant="plain" className="border-t-0 pt-0">
              <SettingTitle className="mb-2.5">{t('code.tool_parameters')}</SettingTitle>
              {toolFields}
            </SettingGroup>
          )}
          {hasAdvancedSection && (
            <SettingGroup variant="plain" className="border-t-0 pt-0">
              <AdvancedConfigToggle open={advancedOpen} onToggle={onAdvancedToggle}>
                <div className="space-y-5">
                  {advancedFields}
                  {files.length > 0 && <CliConfigEditor files={files} error={error} onChange={onFilesChange} />}
                </div>
              </AdvancedConfigToggle>
            </SettingGroup>
          )}
        </SettingContainer>

        <DialogFooter className="justify-end gap-2">
          <Button ref={cancelButtonRef} variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" size="sm" onClick={onSubmit} disabled={!canSave} loading={submitting}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
