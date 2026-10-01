// fork 移植自 cherry-studio v2 src/renderer/components/icons/CliIcon.tsx（2026-09-24）。
// fork 缝（品牌图标）：V2 @cherrystudio/ui/icons 的品牌 SVG fork 没有现成封装——
// dsh 用 fork 已有的 DeepSeek provider logo 资产（assets/images/providers/deepseek.png），
// hermes 用 从 V2 ui 包逐字搬运的 Nousresearch SVG（components/Icons/NousresearchIcon，
// fill=currentColor 适配双主题——用户裁决"hermes 有自己的图标，不要通用图标"）。
// paper-agent：用户 2026-09-29 提供位图 → components/Icons/PaperAgentIcon（此前是 lucide 占位）。
// CLI_TOOLS 裁到 3 项；OPTICAL_VIEWBOXES 随 SVG 源裁剪移除（位图/lucide 图标无 viewBox 面）。

import DeepSeekLogo from '@renderer/assets/images/providers/deepseek.png'
import NousresearchIcon from '@renderer/components/Icons/NousresearchIcon'
import PaperAgentIcon from '@renderer/components/Icons/PaperAgentIcon'
import { cn } from '@renderer/utils/style'
import { CodeCli } from '@shared/types/codeCli'
import type { ComponentType, FC } from 'react'

/** V2 `@cherrystudio/ui/icons` IconComponent 的 fork 消费面（CliIcon/types.ts 回挂用）。 */
export type IconComponent = ComponentType<{ size?: number; className?: string }>

// fork 缝（续）：位图 logo 包一层带尺寸的组件，SVG 直用——两者对齐 IconComponent 签名。
const DeepSeekHarnessIcon: IconComponent = ({ size = 28, className }) => (
  <img src={DeepSeekLogo} width={size} height={size} alt="" className={cn('object-contain', className)} />
)

const HermesIcon: IconComponent = ({ size = 28, className }) => (
  <NousresearchIcon width={size} height={size} className={className} />
)

const PaperAgentToolIcon: IconComponent = ({ size = 28, className }) => (
  <PaperAgentIcon size={size} className={className} />
)

/** `label` is an i18n key; resolve it with `t()` before rendering. */
export const CLI_TOOLS = [
  { value: CodeCli.DEEPSEEK_HARNESS, label: 'code.cli_tools.deepseek_harness', icon: DeepSeekHarnessIcon },
  { value: CodeCli.HERMES, label: 'code.cli_tools.hermes', icon: HermesIcon },
  { value: CodeCli.PAPER_AGENT, label: 'code.cli_tools.paper_agent', icon: PaperAgentToolIcon }
] as const satisfies ReadonlyArray<{ value: CodeCli; label: string; icon: IconComponent }>

// （）：图标表按**真实契约** IconComponent（size/className）存——原来存成
// SvgIcon（SVGProps）并在渲染处传 width/height，而三个图标组件读的都是 `size`：dsh 的位图
// 图标因此恒为默认 28px，传入的 size 完全失效（hermes 的 SVG 恰好也吃 width/height 才没露）。
const CLI_ICONS: Record<string, IconComponent> = Object.fromEntries(CLI_TOOLS.map((tool) => [tool.value, tool.icon]))

interface CliIconProps {
  id: string
  size?: number
  className?: string
}

export const CliIcon: FC<CliIconProps> = ({ id, size = 28, className }) => {
  const Icon = CLI_ICONS[id]
  if (!Icon) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md bg-accent/50 font-medium text-muted-foreground',
          className
        )}
        style={{ width: size, height: size, fontSize: size * 0.4 }}>
        {id.charAt(0).toUpperCase()}
      </div>
    )
  }

  return <Icon size={size} className={className} />
}
