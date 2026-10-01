import { CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { Button } from 'antd'
import type { FC } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  x: number
  y: number
  message: string
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmDialog: FC<Props> = ({ x, y, message, onConfirm, onCancel }) => {
  const dialogRef = useRef<HTMLDivElement>(null)

  // c2-46：原实现用一个只比对话框低一层的全屏透明遮罩承担「点击外部取消」。
  // 对话框可见期间，页面上任何其他交互都会先命中遮罩并直接触发 `onCancel` ——
  // 用户想点别的按钮会先「取消」再穿透。改为在 document 上听 mousedown，
  // 只在指针确实落在对话框之外时取消。
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && dialogRef.current?.contains(target)) return
      onCancel()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [onCancel])

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="-translate-x-1/2 -translate-y-full fixed z-[99999] mt-[-8px] transform"
      style={{
        left: `${x}px`,
        top: `${y}px`
      }}>
      <div className="flex min-w-[160px] items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
        <div className="mr-2 text-sm leading-[1.4]">{message}</div>
        <div className="flex justify-center gap-2">
          <Button
            onClick={onCancel}
            shape="circle"
            size="small"
            danger
            icon={<CloseOutlined />}
            style={{ width: 24, height: 24, minWidth: 24 }}
          />
          <Button
            onClick={onConfirm}
            shape="circle"
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            style={{ width: 24, height: 24, minWidth: 24, backgroundColor: '#52c41a' }}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

export default ConfirmDialog
