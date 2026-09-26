import { ArrowUpToLine, CircleMinus, GripVertical, Play, SquarePen } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { getProviderLogo } from '@renderer/config/providers'
import { ProviderAvatarPrimitive } from '@renderer/components/ProviderAvatar'
import { isApiGatewayProviderId } from '@shared/types/codeCli'

import { Button, GatewayIcon, NormalTooltip } from './shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/ConfigCard.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点三处，卡片渲染（拖拽把手/头像/名称行/悬停脚位）逐字：
// ① 图标缝：V2 `useIcon(resolveProviderIconRef(provider.id))`（V2 图标注册表）→ fork
//   getProviderLogo(provider.id) 位图资产（dsh→deepseek.png 等）；ProviderAvatarPrimitive 的
//   V2 logo ReactNode 面 → fork logoSrc 面（同组件名，fork 移植件见 components/ProviderAvatar.tsx）。
// ② UI 面缝：Button/NormalTooltip/GatewayIcon → 本页 shim（GatewayIcon 以 lucide RadioTower 等值）。
// ③ 视觉缝：V2 复合状态色令牌不涉本文件；className 串保留原文。

export interface ProviderCardProps {
  provider: Provider
  providerName: string
  modelName?: string
  /** Optional one-line blurb shown under the name — used to promote the unified gateway. */
  description?: string
  isCurrent: boolean
  actionsDisabled?: boolean
  dragging?: boolean
  onMoveToTop?: (provider: Provider) => void
  onConfigure: (provider: Provider) => void
  onToggleCurrent: (provider: Provider) => void
}

import type { Provider } from '../cliConfig/providerView'

/** A single enabled-provider row for a CLI tool. Single-select: Enable + Configure
 * are revealed on hover. */
export const ProviderCard: FC<ProviderCardProps> = ({
  provider,
  providerName,
  modelName,
  description,
  isCurrent,
  actionsDisabled,
  dragging,
  onMoveToTop,
  onConfigure,
  onToggleCurrent
}) => {
  const { t } = useTranslation()
  const isGateway = isApiGatewayProviderId(provider.id)
  // fork 缝①（续）：V2 为 `const providerIcon = useIcon(resolveProviderIconRef(provider.id))`。
  const providerLogoSrc = getProviderLogo(provider.id)

  return (
    <div
      className={`group relative rounded-xl border p-3.5 transition-colors ${
        dragging
          ? 'border-primary/40 opacity-50'
          : isCurrent
            ? 'border-primary bg-primary/5'
            : 'border-border-subtle hover:border-border hover:bg-primary/5'
      }`}>
      <div className="pointer-events-none relative flex items-center gap-3">
        <GripVertical
          size={13}
          className="pointer-events-auto shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        />

        <span aria-hidden className="shrink-0">
          {isGateway ? (
            // The unified gateway wears a broadcast-tower glyph (relay/hub metaphor) instead of a brand logo.
            <span className="flex size-6 items-center justify-center rounded-md border border-border-subtle bg-background text-foreground">
              <GatewayIcon width={15} height={15} />
            </span>
          ) : (
            <ProviderAvatarPrimitive
              providerId={provider.id}
              providerName={providerName}
              logoSrc={providerLogoSrc}
              size={24}
              className="rounded-md border border-border-subtle"
            />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm text-foreground">{providerName}</span>
            {modelName && (
              <>
                <span aria-hidden className="shrink-0 text-xs text-foreground-tertiary">
                  ｜
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-foreground-tertiary">{modelName}</span>
              </>
            )}
          </div>
          {description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>}
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
          {onMoveToTop && (
            <NormalTooltip content={t('code.move_provider_to_top')} side="top" sideOffset={4} delayDuration={300}>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t('code.move_provider_to_top')}
                onClick={() => onMoveToTop(provider)}
                className="size-6 border-border-subtle">
                <ArrowUpToLine size={13} />
              </Button>
            </NormalTooltip>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onConfigure(provider)}
            disabled={actionsDisabled}
            className="min-h-0 border-border-subtle px-2.5 py-1">
            <SquarePen size={11} />
            {t('code.configure')}
          </Button>
          <Button
            type="button"
            variant={isCurrent ? 'destructive' : 'default'}
            size="sm"
            onClick={() => onToggleCurrent(provider)}
            disabled={actionsDisabled}
            className="min-h-0 px-2.5 py-1">
            {isCurrent ? <CircleMinus size={11} /> : <Play size={11} />}
            {isCurrent ? t('code.disable') : t('code.enable')}
          </Button>
        </div>
      </div>
    </div>
  )
}
