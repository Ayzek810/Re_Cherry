import type { FC } from 'react'

import { Button } from '../shadcn'
import { cn } from '@renderer/utils/style'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/PanelPrimitives.tsx
//（2026-09-24，v0.3.4-1 批次4b）。逐字；import 面对号（Button ← 本页 shim，ref 直传面同 shim）。

/** "Advanced Settings" toggle (ghost button with a leading icon). */
export const AdvancedSettingsButton: FC<React.ComponentPropsWithoutRef<typeof Button>> = ({
  type = 'button',
  variant = 'ghost',
  size = 'sm',
  className,
  ...props
}) => (
  <Button
    type={type}
    variant={variant}
    size={size}
    className={cn(
      'h-8 w-fit gap-1.5 bg-transparent px-0 text-primary opacity-70 shadow-none hover:bg-transparent hover:text-primary hover:opacity-100 active:bg-transparent active:opacity-100',
      className
    )}
    {...props}
  />
)
