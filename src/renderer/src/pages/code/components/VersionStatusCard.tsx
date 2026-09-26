import { ArrowUpCircle, Download, ExternalLink, Pin, PinOff, Play, Square, Trash2 } from 'lucide-react'
import { type FC, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { useMinapps } from '@renderer/hooks/useMinapps'

import { BinaryInstallFailureRow, BinaryInstallingHint } from './BinaryInstallErrorDialog'
import { CliIcon } from './CliIcon'
import { Button, Tooltip } from './shadcn'

import type { VersionStatus } from '../types'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/VersionStatusCard.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点三处，状态推导/四脚位（upgrade/remove/retry/launch）与
// 启动按钮 aria 语义逐字：
// ① operation 面缝：fork VersionStatus 无 operation 广播面（见 ../types 缝注）——removing/
//   failedInstall/failedRemoval 恒 false，retry 走 applicationStatus（broken/unknown）臂，
//   安装失败行（BinaryInstallFailureRow）由 installError prop（装配点恒 undefined，见
//   useCodeCliPageViewProps 缝⑤）驱动，形状保留。
// ② UI 面缝：Button/Tooltip → 本页 shim；CliIcon → 本页移植件；BinaryInstall* ← 本页移植件。
// ③ 视觉缝：V2 复合状态色令牌（success-border/success-subtle/warning-subtle 族）→ fork 的
//   success/warning 透明度修饰（见 shadcn.tsx 视觉缝注）；"applicationStatus === 'conflict'|'unknown'"
//   臂中 conflict 在 fork 状态面不存在，比较保留原文形状（多一个恒假臂无害）。

interface VersionStatusCardProps {
  toolId: string
  toolName: string
  status: VersionStatus
  onInstall?: () => void
  onUpgrade?: () => void
  onRemove?: () => void
  onLaunch?: () => void
  onStop?: () => void
  onOpenDashboard?: () => void
  isInstalling?: boolean
  isUpgrading?: boolean
  upgradeDisabled?: boolean
  canLaunch?: boolean
  launching?: boolean
  running?: boolean
  stopping?: boolean
  launchDisabledHint?: string
  /** Failure message of the last install/upgrade attempt; renders a persistent failure row. */
  installError?: string
  onShowError?: () => void
  /** v0.3.4-2：首探窗口（快照未返回）——安装按钮显示「检查中」而非可点击态。 */
  snapshotsLoading?: boolean
  /** v0.3.4-2：安装步骤进度（i18n 键尾；当前工具安装中时由主进程广播）。 */
  installProgressStep?: string
}

export const VersionStatusCard: FC<VersionStatusCardProps> = ({
  toolId,
  toolName,
  status,
  onInstall,
  onUpgrade,
  onRemove,
  onLaunch,
  onStop,
  onOpenDashboard,
  isInstalling,
  isUpgrading,
  upgradeDisabled,
  canLaunch,
  launching,
  running,
  stopping,
  launchDisabledHint,
  installError,
  onShowError,
  snapshotsLoading,
  installProgressStep
}) => {
  const { t } = useTranslation()
  const launchDisabledHintId = useId()
  // fork 缝（v0.3.4-2 用户裁决）：启动按钮右边的「固定到启动台」——把当前工具的加号页
  // 快捷方式一键建好/移除，不必先启动再右键侧栏磁贴。磁贴对象与 openSmartMinapp 的
  // transient 应用同形（url 留空：启动台点击进 /code 管理页，不消费 url）。
  const { pinned, updatePinnedMinapps } = useMinapps()
  const launchpadAppId = `code-mate-${toolId}`
  const isPinnedToLaunchpad = pinned.some((p) => p.id === launchpadAppId)
  const toggleLaunchpadPin = () => {
    updatePinnedMinapps(
      isPinnedToLaunchpad
        ? pinned.filter((p) => p.id !== launchpadAppId)
        : [...pinned, { id: launchpadAppId, name: toolName, url: '' }]
    )
  }
  const isInstalled = status.installed
  const canUpgrade = isInstalled && status.canUpgrade
  // fork 缝①（续）：removing/failedRemoval 恒 false（无 operation 面）；retry 的 failed-install 臂
  // 随之消失，'conflict'/'unknown' 臂随 fork 状态面（'applied'|'broken'|'absent'）裁剪——
  // broken 即 retry 面。
  const retryInstall = !!onInstall && status.applicationStatus === 'broken'
  const canRemove = !!onRemove && (status.applicationStatus === 'applied' || status.applicationStatus === 'broken')
  const installing = isInstalling || isUpgrading
  const busy = installing
  // "Up to date" must describe a genuinely current tool. A runnable-but-not-applied
  // mise state (broken) still reports installed with no upgrade, so
  // gate the badge on a clean application fact to avoid pairing it with Retry. A
  // system source carries no application fact and stays eligible.
  // fork 缝①（续）：同上——'conflict'/'unknown' 臂不保留。
  const cleanlyInstalled = isInstalled && status.applicationStatus !== 'broken'
  const launchUnavailable = !running && !canLaunch

  const launchButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={launchUnavailable ? undefined : running ? onStop : onLaunch}
      disabled={busy || (running ? stopping : launching) || (launchUnavailable && !launchDisabledHint)}
      aria-disabled={(launchUnavailable && !!launchDisabledHint) || undefined}
      aria-describedby={launchUnavailable && launchDisabledHint ? launchDisabledHintId : undefined}
      className={
        running
          ? 'shrink-0 text-destructive hover:text-destructive'
          : `shrink-0 text-foreground${launchUnavailable ? 'cursor-not-allowed opacity-40' : ''}`
      }>
      {running && stopping ? (
        <>
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          {t('code.stop')}
        </>
      ) : running ? (
        <>
          <Square size={12} />
          {t('code.stop')}
        </>
      ) : launching ? (
        <>
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          {t('code.launching')}
        </>
      ) : (
        <>
          <Play size={12} />
          {t('code.launch.label')}
        </>
      )}
    </Button>
  )

  return (
    <div className="rounded-lg border border-border-subtle bg-background px-4 py-5">
      <div className="flex items-center gap-3">
        <CliIcon id={toolId} size={28} className="size-7 shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{toolName}</span>
            {status.source === 'system' ? (
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title={status.systemPath}>
                {t('settings.dependencies.source.system')}
              </span>
            ) : (
              cleanlyInstalled &&
              !canUpgrade && (
                <span className="shrink-0 rounded border border-success/35 bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
                  {t('code.up_to_date')}
                </span>
              )
            )}
          </div>

          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {isInstalled
              ? status.current && <span className="font-mono">v{status.current}</span>
              : status.latest && (
                  <>
                    <span>{t('code.latest')}</span>
                    <span className="font-mono">v{status.latest}</span>
                  </>
                )}
            {canUpgrade && (
              <>
                <ArrowUpCircle size={11} className="shrink-0 text-warning" />
                <span className="font-mono text-warning">v{status.latest}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isInstalled && canUpgrade && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onUpgrade}
              disabled={busy || upgradeDisabled}
              className="shrink-0 gap-1 text-warning hover:bg-warning/15 hover:text-warning">
              {isUpgrading ? (
                <>
                  <span className="size-3 animate-spin rounded-full border-2 border-warning/35 border-t-warning" />
                  {t('code.installing')}
                </>
              ) : (
                <>
                  <ArrowUpCircle size={12} />
                  {t('code.upgrade')}
                </>
              )}
            </Button>
          )}

          {canRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              disabled={busy}
              aria-label={t('settings.dependencies.uninstall')}
              title={t('settings.dependencies.uninstall')}>
              <Trash2 className="size-3.5" />
            </Button>
          )}

          {retryInstall && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onInstall}
              disabled={busy}
              className="shrink-0 text-muted-foreground hover:border-border hover:text-foreground">
              <Download size={12} />
              {t('common.retry')}
            </Button>
          )}

          {isInstalled ? (
            <>
              {launchDisabledHint && launchUnavailable ? (
                <Tooltip content={launchDisabledHint} placement="top" delay={300} sideOffset={6}>
                  {launchButton}
                </Tooltip>
              ) : (
                launchButton
              )}
              {launchDisabledHint && launchUnavailable ? (
                <span id={launchDisabledHintId} className="sr-only">
                  {launchDisabledHint}
                </span>
              ) : null}
              {/* fork 缝（v0.3.4-2）：启动右边的「固定到启动台」开关 */}
              <Tooltip
                content={t(isPinnedToLaunchpad ? 'minapp.remove_from_launchpad' : 'minapp.add_to_launchpad')}
                placement="top"
                delay={300}
                sideOffset={6}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleLaunchpadPin}
                  disabled={busy}
                  aria-label={t(isPinnedToLaunchpad ? 'minapp.remove_from_launchpad' : 'minapp.add_to_launchpad')}
                  title={t(isPinnedToLaunchpad ? 'minapp.remove_from_launchpad' : 'minapp.add_to_launchpad')}
                  className={isPinnedToLaunchpad ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}>
                  {isPinnedToLaunchpad ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </Button>
              </Tooltip>
            </>
          ) : (
            // fork 缝①（续）：failedRemoval 臂恒 false（无 operation 面），比较式随状态面裁剪。
            // v0.3.4-2：快照首探窗口显示「检查中」disabled 态——期间安装键可点会诱导重装
            //（用户担忧的极限场景）。
            !retryInstall &&
            (snapshotsLoading ? (
              <Button type="button" variant="outline" size="sm" disabled className="shrink-0 text-muted-foreground">
                <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                {t('code.checking')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onInstall}
                disabled={busy}
                className="shrink-0 text-muted-foreground hover:border-border hover:text-foreground">
                {installing ? (
                  <>
                    <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                    {t('code.installing')}
                  </>
                ) : (
                  <>
                    <Download size={12} />
                    {installError ? t('common.retry') : t('code.install')}
                  </>
                )}
              </Button>
            ))
          )}

          {isInstalled && running && onOpenDashboard && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenDashboard}
              className="shrink-0 text-foreground">
              <ExternalLink size={12} />
              {t('code.open_web_ui')}
            </Button>
          )}
        </div>
      </div>

      {installing && <BinaryInstallingHint />}
      {/* v0.3.4-2（用户裁决）：安装进度条——主进程广播的阶段步名，不确定进度 + 步名文本。 */}
      {installing && installProgressStep && (
        <div className="mt-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground/50" />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(`code.install_progress.${installProgressStep}`)}
          </p>
        </div>
      )}
      {installError && !busy && onShowError && (
        <BinaryInstallFailureRow error={installError} onShowError={onShowError} />
      )}
    </div>
  )
}
