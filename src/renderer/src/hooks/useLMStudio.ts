import store, { useAppSelector } from '@renderer/store'
import { setLMStudioKeepAliveTime } from '@renderer/store/llm'
import { useDispatch } from 'react-redux'

export function useLMStudioSettings() {
  const settings = useAppSelector((state) => state.llm.settings.lmstudio)
  const dispatch = useDispatch()

  return { ...settings, setKeepAliveTime: (time: number) => dispatch(setLMStudioKeepAliveTime(time)) }
}

