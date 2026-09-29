// fork 缝（原创，v0.4.5-1）：受管工具安装进度的**标准元素**。
//
// 它把"安装进度"这件事收成一处，任何要展示安装进度的界面（三个工具的版本卡，未来的第四个
// 工具、设置页的依赖面板、小程序卡片……）都复用它，而不是各自复制 markup：
// - 文案由共享词汇表 `InstallProgressStep` 决定（键固定 `code.install_progress.<step>`），
//   步骤名写错是编译错误；
// - 比例只在主进程给了 fraction 时画真条（下载阶段），其余阶段画不确定态——不编造百分比；
// - 阶段一变即重挂（key=step），所以条的宽度不会从上一阶段的 80% 缓动下来；
// - 起步下限 2%：0% 时也看得见"条在那儿"。
//
// 底座是 shadcn.tsx 的 `Progress`（与 Button/Tooltip 同档的标准 primitive）。

import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import type { InstallProgressStep } from '@shared/types/installProgress'

import { Progress } from './shadcn'

/** 确定性比例换算成百分比：下限 2%（可见）、上限 100%（防浮点越界）。 */
export function progressPercentOf(fraction: number | undefined): number | undefined {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined
  return Math.max(2, Math.min(100, Math.round(fraction * 100)))
}

interface InstallProgressProps {
  step: InstallProgressStep
  /** 语言无关的补充事实（下载字节数等），由主进程给，这里原样展示。 */
  detail?: string
  /** 0..1；缺省 = 本阶段不可测（不确定态）。 */
  fraction?: number
  className?: string
}

export const InstallProgress: FC<InstallProgressProps> = ({ step, detail, fraction, className }) => {
  const { t } = useTranslation()
  const percent = progressPercentOf(fraction)
  return (
    <Progress
      // 阶段切换即重挂：条从新阶段的起点开始，不继承上一阶段的宽度。
      key={step}
      className={className}
      value={percent}
      label={t(`code.install_progress.${step}`)}
      {...(detail ? { detail } : {})}
    />
  )
}
