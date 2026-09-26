import { allMinApps } from '@renderer/config/minapps'
import type { MinAppType } from '@renderer/types'
import type { FC } from 'react'

import NousresearchIcon from './NousresearchIcon'
import DeepSeekLogo from '../../assets/images/providers/deepseek.png'

interface Props {
  app: MinAppType
  sidebar?: boolean
  size?: number
  style?: React.CSSProperties
}

// 批次5（CodeMate）：受管 Web UI 的磁贴图标 fallback——openSmartMinapp 未带 logo 的
// code-mate 应用（dsh/hermes）在侧栏/启动台/固定区都需要一个图标。dsh 用 DeepSeek
// provider 位图，hermes 用 Nousresearch SVG（fill=currentColor 主题自适应）。
function CodeMateIcon({ app, size }: { app: MinAppType; size: number }) {
  if (app.id === 'code-mate-deepseek-harness') {
    return (
      <img
        src={DeepSeekLogo}
        className="select-none rounded-2xl"
        style={{ width: `${size}px`, height: `${size}px`, userSelect: 'none' }}
        draggable={false}
        alt={app.name || 'MinApp Icon'}
      />
    )
  }
  if (app.id === 'code-mate-hermes') {
    return <NousresearchIcon width={size} height={size} />
  }
  return null
}

const MinAppIcon: FC<Props> = ({ app, size = 48, style, sidebar = false }) => {
  // First try to find in allMinApps for predefined styling
  const _app = allMinApps.find((item) => item.id === app.id)

  // If found in allMinApps, use predefined styling
  if (_app) {
    return (
      <img
        src={_app.logo}
        className="select-none rounded-2xl"
        style={{
          border: _app.bodered ? '0.5px solid var(--color-border)' : 'none',
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: _app.background,
          userSelect: 'none',
          ...(sidebar ? {} : app.style),
          ...style
        }}
        draggable={false}
        alt={app.name || 'MinApp Icon'}
      />
    )
  }

  // If not found in allMinApps but app has logo, use it (for temporary apps)
  if (app.logo) {
    return (
      <img
        src={app.logo}
        className="select-none rounded-2xl"
        style={{
          border: 'none',
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: 'transparent',
          userSelect: 'none',
          ...(sidebar ? {} : app.style),
          ...style
        }}
        draggable={false}
        alt={app.name || 'MinApp Icon'}
      />
    )
  }

  // 批次5：code-mate 受管 Web UI 的图标 fallback（无 logo 资产的品牌图标组件）。
  const codeMateIcon = CodeMateIcon({ app, size })
  if (codeMateIcon) return codeMateIcon

  return null
}

export default MinAppIcon
