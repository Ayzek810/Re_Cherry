/**
 * v0.3.2 自 CS_V1 移植（文档预处理服务商）。
 * 批次1 为静态默认表桩；本次接真：读写 store/preprocess 切片（随 rootReducer 持久化）。
 * 三个 hook 照上游形状：列表读写 / 单个读写（apiKey/apiHost/model 变更时双写
 * knowledge 切片 syncPreprocessProvider，同步进所有引用该 provider 的知识库内嵌副本）/
 * 默认服务商。设置页（/settings/docprocess）负责编辑，知识库弹窗经
 * useKnowledgeBaseForm → usePreprocessProviders 消费。
 */
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { syncPreprocessProvider } from '@renderer/store/knowledge'
import {
  setDefaultPreprocessProvider as setDefaultPreprocessProviderAction,
  updatePreprocessProvider as updatePreprocessProviderAction,
  updatePreprocessProviders as updatePreprocessProvidersAction
} from '@renderer/store/preprocess'
import type { PreprocessProvider, PreprocessProviderId } from '@renderer/types'
import { useDispatch } from 'react-redux'

export { defaultPreprocessProviders } from '@renderer/config/preprocessProviders'

/** apiHost/apiKey/model 三字段是"会同步进知识库内嵌副本"的配置面。 */
const SYNC_FIELDS: Array<keyof PreprocessProvider> = ['apiHost', 'apiKey', 'model']

export const usePreprocessProviders = () => {
  const dispatch = useAppDispatch()
  const preprocessProviders = useAppSelector((state) => state.preprocess.providers)
  return {
    preprocessProviders,
    updatePreprocessProviders: (providers: PreprocessProvider[]) => {
      dispatch(updatePreprocessProvidersAction(providers))
    }
  }
}

export const usePreprocessProvider = (id: PreprocessProviderId) => {
  const dispatch = useDispatch()
  const provider = useAppSelector((state) => state.preprocess.providers.find((p) => p.id === id))
  return {
    provider,
    updateProvider: (updates: Partial<PreprocessProvider>) => {
      dispatch(updatePreprocessProviderAction({ id, updates }))
      if (SYNC_FIELDS.some((field) => field in updates)) {
        dispatch(syncPreprocessProvider(updates))
      }
    }
  }
}

export const useDefaultPreprocessProvider = () => {
  const dispatch = useAppDispatch()
  const defaultProviderId = useAppSelector((state) => state.preprocess.defaultProvider)
  const provider = useAppSelector((state) => state.preprocess.providers.find((p) => p.id === defaultProviderId))
  return {
    /** 默认服务商 id（原始形态，照上游 state.defaultProvider）。 */
    defaultProvider: defaultProviderId,
    provider,
    setDefaultPreprocessProvider: (target: PreprocessProvider) => {
      dispatch(setDefaultPreprocessProviderAction(target.id))
    },
    updateDefaultPreprocessProvider: (updates: Partial<PreprocessProvider>) => {
      dispatch(updatePreprocessProviderAction({ id: defaultProviderId, updates }))
    }
  }
}
