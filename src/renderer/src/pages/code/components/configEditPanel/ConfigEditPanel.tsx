import type { FC } from 'react'

import { ConfigEditDialogBody } from './ConfigEditDialogBody'
import type { ConfigEditPanelProps } from './types'
import { useConfigEditPanelBodyProps } from './useConfigEditPanelBodyProps'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/ConfigEditPanel.tsx
//（2026-09-24）。逐字；import 面对号（types ← fork 4a 前移面）。

export type { ConfigEditPanelProps } from './types'

export const ConfigEditPanel: FC<ConfigEditPanelProps> = (props) => {
  const bodyProps = useConfigEditPanelBodyProps(props)
  return <ConfigEditDialogBody {...bodyProps} />
}
