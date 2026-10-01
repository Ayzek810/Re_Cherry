import type { CodeCli } from '@shared/types/codeCli'
import { ArrowUpToLine, CircleMinus, Play, SquarePen } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { CliIcon } from './CliIcon'
import { Button, NormalTooltip } from './shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/OwnLoginCard.tsx
//（2026-09-24）。逐字；import 面对号（CliIcon/Button/NormalTooltip ← 本页移植件
// 与 shim）。fork 的 LOGIN_CAPABLE_CLI_TOOLS 为空集——消费点（ConfigList）在 fork 为不可达面。
//
// 与 ProviderCard 同法——去掉 `cursor-grab` 拖拽把手与 `dragging` 高亮
//（ReorderableList 不实现拖拽），"置顶"按钮改为常显。

export interface OwnLoginCardProps {
  toolId: CodeCli
  toolName: string
  selected: boolean
  configurable?: boolean
  onMoveToTop?: () => void
  onToggle: () => void
  onConfigure?: () => void
}

/** Virtual "use your own login" row for login-capable CLI tools. Mirrors
 * `ProviderCard` (single-select) but drops the model label. Tools whose own-login
 * exposes tool params (`configurable`) also get a hover-revealed Configure button. */
export const OwnLoginCard: FC<OwnLoginCardProps> = ({
  toolId,
  toolName,
  selected,
  configurable,
  onMoveToTop,
  onToggle,
  onConfigure
}) => {
  const { t } = useTranslation()
  const title = t('code.own_login.title', { toolName })

  return (
    <div
      className={`group relative rounded-xl border p-3.5 transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-border-subtle hover:border-border hover:bg-primary/5'
      }`}>
      <div className="pointer-events-none relative flex items-center gap-3">
        <span aria-hidden className="shrink-0">
          <CliIcon id={toolId} size={24} className="size-6 rounded-md border border-border-subtle" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-foreground text-sm">{title}</span>
          </div>
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          {onMoveToTop && (
            <NormalTooltip content={t('code.move_provider_to_top')} side="top" sideOffset={4} delayDuration={300}>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t('code.move_provider_to_top')}
                onClick={onMoveToTop}
                className="size-6 border-border-subtle">
                <ArrowUpToLine size={13} />
              </Button>
            </NormalTooltip>
          )}
          <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
            {configurable && onConfigure && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onConfigure()}
                className="min-h-0 border-border-subtle px-2.5 py-1">
                <SquarePen size={11} />
                {t('code.configure')}
              </Button>
            )}
            <Button
              type="button"
              variant={selected ? 'destructive' : 'default'}
              size="sm"
              onClick={onToggle}
              className="min-h-0 px-2.5 py-1">
              {selected ? <CircleMinus size={11} /> : <Play size={11} />}
              {selected ? t('code.disable') : t('code.enable')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
