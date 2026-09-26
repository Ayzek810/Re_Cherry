import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getStoreProviders } from '@renderer/hooks/useStore'
import { isApiGatewayProviderId } from '@shared/types/codeCli'

import type { ApiKeyEntry } from '../../cliConfig'
import type { ConfigEditDialogBodyProps } from './ConfigEditDialogBody'
import { ModelSelect } from './ModelSelect'
import { renderToolFields } from './toolFieldRenderer'
import type { ConfigEditPanelProps } from './types'
import { useConfigDraftController } from './useConfigDraftController'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/
// useConfigEditPanelBodyProps.tsx（2026-09-24，v0.3.4-1 批次4b）。缝点七处，初载门控/模型槽/
// foreign 字段锁定（fieldset disabled）逐字：
// ① keys 缝：V2 `useProviderApiKeys(provider.id)`（DataApi 密钥表）→ fork provider 单 apiKey 字段
//   （useCurrentCliConfigConnection 缝①同款：getStoreProviders 直读，同形单条 ApiKeyEntry）。
// ② 显示名缝：getProviderDisplayName → fork provider.name（4a useConfigMetadata 缝③）。
// ③ 图标缝：resolveProviderIconRef/useIcon 不搬（图标消费只存在于 V2 DialogTitle 的头像——
//   fork 由 ConfigEditDialogBody 缝以首字母回退渲染）。
// ④ 主题缝：useTheme/SettingContainer 的 theme 面不搬（fork 无该主题面，见 SettingsPrimitives 缝）。
// ⑤ 模型选择缝：V2 ModelSelector（自绘 popup + onSettingsNavigate 深链面）→ fork ModelSelect
//   适配器（antd Select 无下拉内导航面，跳转入口由对话框标题的外链按钮承担，见
//   ConfigEditDialogBody 缝③）；useCloseBeforeAction 不搬（唯一消费点随⑤消失）。
// ⑥ Claude 臂删除：isClaudeTool/claudeModelMode/claudeDetailedModelSlot 随 claudeModels.ts 未移植
//   裁剪（见 4a useConfigMetadata 缝④）。
// ⑦ 路由缝：providerSettingsPath 保持 V2 形状（'/settings/provider?id=' 深链 fork 既有；
//   '/settings/api-gateway' 随网关 dormant 面保留形状）。

export function useConfigEditPanelBodyProps({
  onClose,
  cliTool,
  provider,
  providerConfig,
  isCurrentProvider,
  modelFilter,
  gateway,
  gatewayModels,
  isGatewayModelsLoading,
  onSubmit
}: ConfigEditPanelProps): ConfigEditDialogBodyProps {
  const { t } = useTranslation()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const providerName = provider.name
  const isGateway = isApiGatewayProviderId(provider.id)

  // The gateway id has no DataApi api-keys record (the query 404s); feed the gateway secret directly
  // so the managed/foreign match resolves against the real key and the initial-load gate isn't stalled.
  // fork 缝①（续）：fork 为单 apiKey 字段（无 DataApi 记录面）。
  const apiKeys: ApiKeyEntry[] | undefined = isGateway
    ? gateway?.apiKey
      ? [{ id: 'gateway', key: gateway.apiKey, isEnabled: true }]
      : []
    : (() => {
        const apiKey = getStoreProviders().find((p) => p.id === provider.id)?.apiKey
        return apiKey ? [{ id: 'default', key: apiKey, isEnabled: true }] : []
      })()
  const modelsById = isGateway ? gatewayModels : undefined

  const {
    draft,
    isForeignDraft,
    submitting,
    canSave,
    onModelSelect,
    onConfigChange,
    onCliConfigFilesChange,
    onSubmit: submitDraft
  } = useConfigDraftController({
    onClose,
    cliTool,
    provider,
    providerConfig,
    isCurrentProvider,
    apiKeys,
    gateway,
    models: modelsById,
    isModelsLoading: isGateway && isGatewayModelsLoading,
    onSubmit
  })

  const unknownCliConfigModelHint: ReactNode =
    isForeignDraft && draft.connection ? (
      <div className="rounded-lg border border-warning/35 bg-warning/15 px-3 py-2 text-warning">
        <div className="font-medium text-xs">{t('code.cli_config.unknown_provider')}</div>
        <div className="mt-1 truncate font-mono text-[11px]">
          {draft.connection.model || t('code.cli_config.unknown_model')}
        </div>
      </div>
    ) : null

  const modelSlot: ReactNode = (
    <>
      {unknownCliConfigModelHint}
      {unknownCliConfigModelHint && <div className="h-2" />}
      <ModelSelect
        value={draft.modelId}
        onSelect={onModelSelect}
        filter={modelFilter}
        placeholder={t('settings.models.empty')}
      />
    </>
  )

  // fork 缝⑥（续）：modelSectionSlot 恒为 modelSlot（detailed 槽随 claude 臂删除）。
  const modelSectionSlot = modelSlot
  // A foreign draft belongs to another provider/tool; tool-field edits would
  // rewrite that file in place, so lock them until the user picks a model
  // (which flips the draft back to managed). Raw-file editing stays open.
  const lockForeignFields = (fields: ReactNode): ReactNode =>
    fields && isForeignDraft ? (
      <fieldset disabled className="min-w-0 opacity-60">
        {fields}
      </fieldset>
    ) : (
      fields
    )
  const advancedFields = lockForeignFields(
    renderToolFields({
      cliTool,
      config: draft.config,
      onChange: onConfigChange,
      section: 'advanced',
      providerId: provider.id,
      modelFilter
    })
  )
  const toolFields = lockForeignFields(
    renderToolFields({
      cliTool,
      config: draft.config,
      onChange: onConfigChange,
      section: 'basic',
      providerId: provider.id,
      modelFilter
    })
  )
  const hasAdvancedSection = !!advancedFields || draft.files.length > 0

  return {
    open: true,
    onClose,
    provider,
    providerName,
    providerSettingsPath: isGateway ? '/settings/api-gateway' : `/settings/provider?id=${provider.id}`,
    modelSectionSlot,
    toolFields,
    advancedFields,
    hasAdvancedSection,
    advancedOpen,
    onAdvancedToggle: () => setAdvancedOpen((o) => !o),
    files: draft.files,
    error: draft.error,
    onFilesChange: onCliConfigFilesChange,
    submitting,
    canSave,
    onSubmit: submitDraft
  }
}
