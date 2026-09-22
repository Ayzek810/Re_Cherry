/**
 * 本地模型状态轮询（v0.3.2 自 CS_V2 useLocalModel 裁剪：进度轮询 getStatus
 * 而非事件订阅——fork 主进程下载服务无事件广播面）。挂载即轮询（1s），
 * 下载中与就绪态开销可忽略（一次轻量 IPC + existsSync）。
 */
import { useCallback, useEffect, useState } from 'react'

export interface LocalModelStatus {
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error' | 'unsupported'
  percent?: number
  error?: string
}

export const useLocalModel = () => {
  const [status, setStatus] = useState<LocalModelStatus>({ status: 'not_downloaded' })

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = (await window.api.localModel.getStatus()) as LocalModelStatus
        if (!cancelled) setStatus(next)
      } catch {
        // 主进程未就绪（boot 窗口）：下轮再取。
      }
      if (!cancelled) timer = window.setTimeout(poll, 1000)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const download = useCallback(() => window.api.localModel.download(), [])
  const cancel = useCallback(() => window.api.localModel.cancel(), [])
  const remove = useCallback(() => window.api.localModel.remove(), [])

  return { status, download, cancel, remove }
}
