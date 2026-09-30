// fork 缝（用户裁决 2026-09-29）：paper-agent 的品牌图标。
//
// 此前是 lucide 的 ScrollText 占位（v0.4.5 说明：上游仓库没有品牌资产，只有社群二维码位图）。
// 用户提供了图标位图（129×129 RGBA），放进 apps/ 资产目录（与其它磁贴 logo 同处），并由本组件
// 包成 IconComponent 形状——这样两个消费面（CliIcon 的 CLI 工具图标、MinAppIcon 的磁贴/启动台
// 图标）共用同一份资产，不会出现"一处换了另一处还是旧占位"。

import PaperAgentLogo from '@renderer/assets/images/apps/paper-agent.png'
import { cn } from '@renderer/utils/style'
import type { FC } from 'react'

const PaperAgentIcon: FC<{ size?: number; className?: string }> = ({ size = 28, className }) => (
  <img src={PaperAgentLogo} width={size} height={size} alt="" className={cn('object-contain', className)} />
)

export default PaperAgentIcon
