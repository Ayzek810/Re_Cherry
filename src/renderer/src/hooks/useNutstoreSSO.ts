import { loggerService } from '@logger'
import { useCallback, useEffect, useRef } from 'react'

const logger = loggerService.withContext('useNutstoreSSO')

/**
 * SSO 回调等待上限。超过上限必须让 Promise 收敛（reject），否则调用方的 `await`
 * 永久挂起（旧实现连超时都没有，用户取消流程时监听器与 Promise 一起常驻）。
 */
const SSO_TIMEOUT_MS = 5 * 60 * 1000

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>
  settle: (result: { token: string } | { error: unknown }) => void
}

export function useNutstoreSSO() {
  const pendingRef = useRef<PendingRequest | null>(null)

  /** 让在途请求以失败收敛（并清掉它的超时定时器）。 */
  const failPending = useCallback((reason: unknown) => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    clearTimeout(pending.timer)
    pending.settle({ error: reason })
  }, [])

  /**
   * 协议监听注册在 effect 中并在卸载时解绑。旧实现每次调用 `nutstoreSSOHandler`
   * 都在 `new Promise` 内注册、且只在收到回调的 `finally` 解绑：用户取消 SSO 或回调不来时
   * 监听器常驻，重复点击叠加监听，Promise 永不 settle，hook 卸载也不清理。
   * 监听器现在跟随 hook 生命周期（整个生命周期只有一个），超时/取消只收敛"在途请求"。
   */
  useEffect(() => {
    const removeListener = window.api.protocol.onReceiveData((data) => {
      const pending = pendingRef.current
      if (!pending) return
      try {
        const url = new URL(data.url)
        const params = new URLSearchParams(url.search)
        const encryptedToken = params.get('s')
        if (!encryptedToken) {
          logger.warn('Nutstore SSO 回调缺少 token 参数，已按失败处理')
          failPending(new Error('Nutstore SSO callback has no token'))
          return
        }
        pendingRef.current = null
        clearTimeout(pending.timer)
        pending.settle({ token: encryptedToken })
      } catch (error) {
        logger.error('解析URL失败:', error as Error)
        failPending(error)
      }
    })
    return () => {
      removeListener()
      failPending(new Error('useNutstoreSSO unmounted'))
    }
  }, [failPending])

  const nutstoreSSOHandler = useCallback(() => {
    return new Promise<string>((resolve, reject) => {
      // 重复点击：作废上一个在途请求（旧实现的两条 promise 都会永久 pending）
      if (pendingRef.current) {
        failPending(new Error('Nutstore SSO superseded by a new request'))
      }

      const timer = setTimeout(() => {
        logger.warn(`Nutstore SSO 回调超时（${SSO_TIMEOUT_MS}ms），在途请求已按失败收敛`)
        failPending(new Error('Nutstore SSO timed out'))
      }, SSO_TIMEOUT_MS)

      pendingRef.current = {
        timer,
        settle: (result) => {
          if ('token' in result) resolve(result.token)
          else reject(result.error)
        }
      }
    })
  }, [failPending])

  return nutstoreSSOHandler
}
