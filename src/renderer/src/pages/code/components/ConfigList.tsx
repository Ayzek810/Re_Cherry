import { type FC, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { isOwnLoginConfigurable } from '@renderer/pages/code/cliConfig'
import { CLI_OWN_LOGIN_PROVIDER_ID, type CodeCli, isApiGatewayProviderId } from '@shared/types/codeCli'
import type { CliProviderConfig } from '@shared/types/codeCliState'

import { OwnLoginCard } from './OwnLoginCard'
import { ProviderCard } from './ConfigCard'
import { EmptyState, ReorderableList } from './shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/ConfigList.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点两处，搜索过滤/置顶/双卡片分派逻辑逐字：
// ① 类型缝：Provider ← providerView 投影、CliProviderConfig ← @shared/types/codeCliState。
// ② UI 面缝：EmptyState/ReorderableList → 本页 shim（拖拽排序未实现，onReorder/move-to-top
//   通道保留，见 shim 缝注）；import 面对号（isOwnLoginConfigurable ← 本页 cliConfig barrel）。

export interface ConfigListProps {
  selectedCliTool: CodeCli
  toolName: string
  providers: Provider[]
  providerConfigs: Record<string, CliProviderConfig>
  currentProviderId: string | null
  currentProviderModelName?: string
  providerActionsDisabled?: boolean
  resolveMeta: (provider: Provider, cfg?: CliProviderConfig) => { providerName: string; modelName?: string }
  onConfigure: (provider: Provider) => void
  onToggleCurrent: (provider: Provider) => void
  onReorder: (nextProviders: Provider[]) => void | Promise<void>
  /** Filter the list by provider display name (case-insensitive). */
  searchTerm?: string
}

import type { Provider } from '../cliConfig/providerView'

/** Enabled-provider list for a tool. Drag a row to reorder (persisted via
 * `onReorder`); empty-state fallback when no provider matches the tool. */
export const ConfigList: FC<ConfigListProps> = ({
  selectedCliTool,
  toolName,
  providers,
  providerConfigs,
  currentProviderId,
  currentProviderModelName,
  providerActionsDisabled,
  resolveMeta,
  onConfigure,
  onToggleCurrent,
  onReorder,
  searchTerm
}) => {
  const { t } = useTranslation()

  const normalizedSearch = searchTerm?.trim().toLowerCase() ?? ''
  const displayedProviders = useMemo(() => {
    if (!normalizedSearch) return providers
    return providers.filter((provider) => {
      const name =
        provider.id === CLI_OWN_LOGIN_PROVIDER_ID
          ? t('code.own_login.title', { toolName })
          : resolveMeta(provider, providerConfigs[provider.id]).providerName
      return name.toLowerCase().includes(normalizedSearch)
    })
  }, [providers, normalizedSearch, t, toolName, resolveMeta, providerConfigs])

  const handleMoveToTop = (provider: Provider) => {
    if (providerActionsDisabled || providers[0]?.id === provider.id) return
    const nextProviders = [provider, ...providers.filter((candidate) => candidate.id !== provider.id)]
    void Promise.resolve(onReorder(nextProviders)).catch(() => undefined)
  }

  if (providers.length === 0) {
    return (
      <EmptyState
        preset="no-code-tool"
        title={t('code.no_providers_title')}
        description={t('code.no_providers_description')}
      />
    )
  }

  if (displayedProviders.length === 0) {
    return <div className="py-8 text-center text-xs text-foreground-tertiary">{t('code.no_matching_providers')}</div>
  }

  return (
    <ReorderableList
      items={providers}
      visibleItems={displayedProviders}
      getId={(p) => p.id}
      onReorder={onReorder}
      disabled={providerActionsDisabled}
      gap="0.5rem"
      itemStyle={{ cursor: 'default' }}
      renderItem={(provider, _index, { dragging }) => {
        const onMoveToTop = providerActionsDisabled || providers[0]?.id === provider.id ? undefined : handleMoveToTop
        if (provider.id === CLI_OWN_LOGIN_PROVIDER_ID) {
          return (
            <OwnLoginCard
              toolId={selectedCliTool}
              toolName={toolName}
              selected={currentProviderId === provider.id}
              configurable={isOwnLoginConfigurable(selectedCliTool)}
              dragging={dragging}
              onMoveToTop={onMoveToTop ? () => onMoveToTop(provider) : undefined}
              onToggle={() => onToggleCurrent(provider)}
              onConfigure={() => onConfigure(provider)}
            />
          )
        }
        const cfg = providerConfigs[provider.id]
        const meta = resolveMeta(provider, cfg)
        const modelName =
          currentProviderId === provider.id && currentProviderModelName ? currentProviderModelName : meta.modelName
        return (
          <ProviderCard
            provider={provider}
            providerName={meta.providerName}
            modelName={modelName}
            description={isApiGatewayProviderId(provider.id) ? t('code.api_gateway.description') : undefined}
            isCurrent={currentProviderId === provider.id}
            actionsDisabled={providerActionsDisabled}
            dragging={dragging}
            onMoveToTop={onMoveToTop}
            onConfigure={onConfigure}
            onToggleCurrent={onToggleCurrent}
          />
        )
      }}
    />
  )
}
