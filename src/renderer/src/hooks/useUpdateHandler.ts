import { useAppDispatch } from '@renderer/store'
import { setUpdateState } from '@renderer/store/runtime'
import type { AppUpdateState } from '@shared/types/appUpdate'
import { useEffect } from 'react'

/**
 * 应用更新的状态接线。
 *
 * 只做两件事：挂载时补拉一次当前状态、之后订阅主进程推送。首次检查由主进程自己调度
 * （启动后延迟做），所以渲染层不触发任何检查——没有界面在场时，更新状态机照样推进。
 */
export default function useUpdateHandler() {
  const dispatch = useAppDispatch()

  useEffect(() => {
    let active = true
    void window.api.update.getState().then((state) => {
      if (active) dispatch(setUpdateState(state as AppUpdateState))
    })
    const unsubscribe = window.api.update.onState((state) => {
      dispatch(setUpdateState(state as AppUpdateState))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [dispatch])
}
