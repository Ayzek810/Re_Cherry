/**
 * LocalPaddle 模型状态轮询（收编自 useLocalModel：本地模型系统并入文档
 * 处理子系统，hook 归位文档处理服务商面板；进度轮询 getStatus 而非事件订阅——
 * 主进程下载服务无事件广播面）。挂载即轮询（1s），下载中与就绪态开销可忽略
 * （一次轻量 IPC + existsSync）。
 */
import { useCallback, useEffect, useState } from 'react'

export interface LocalPaddleStatus {
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error' | 'unsupported'
  percent?: number
  error?: string
}

export const useLocalPaddle = () => {
  const [status, setStatus] = useState<LocalPaddleStatus>({ status: 'not_downloaded' })

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = (await window.api.preprocess.localPaddle.getStatus()) as LocalPaddleStatus
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

  const download = useCallback(() => window.api.preprocess.localPaddle.download(), [])
  const cancel = useCallback(() => window.api.preprocess.localPaddle.cancel(), [])
  const remove = useCallback(() => window.api.preprocess.localPaddle.remove(), [])

  return { status, download, cancel, remove }
}
