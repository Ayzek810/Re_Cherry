/** v0.3.2 自 CS_V1 移植（文档预处理服务商配置；批次1 无切片，本次接真）。
 * 形态照上游 store/preprocess：providers 数组（PreprocessProvider 含 apiKey/apiHost/model）
 * + defaultProvider（设置页受控下拉的选中态），随 rootReducer 持久化。
 * 密钥为明文落盘——与 websearch 切片同批先例（LLM 专属的 ProviderKeyStore 金库加固
 * 不覆盖此类服务密钥）。设置页改动经 hooks 双写同步进知识库内嵌引用（syncPreprocessProvider）。 */
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import { defaultPreprocessProviders } from '@renderer/config/preprocessProviders'
import type { PreprocessProvider } from '@renderer/types'

export interface PreprocessState {
  providers: PreprocessProvider[]
  /** 默认文档处理服务商 id（上游默认 'mineru'）。 */
  defaultProvider: string
}

export const initialState: PreprocessState = {
  providers: defaultPreprocessProviders,
  defaultProvider: 'mineru'
}

const preprocessSlice = createSlice({
  name: 'preprocess',
  initialState,
  reducers: {
    setDefaultPreprocessProvider: (state, action: PayloadAction<string>) => {
      state.defaultProvider = action.payload
    },
    updatePreprocessProviders: (state, action: PayloadAction<PreprocessProvider[]>) => {
      state.providers = action.payload
    },
    /** 按 id 局部更新单个服务商（不存在则忽略——服务商集合固定为默认五家）。 */
    updatePreprocessProvider: (state, action: PayloadAction<{ id: string; updates: Partial<PreprocessProvider> }>) => {
      const index = state.providers.findIndex((provider) => provider.id === action.payload.id)
      if (index !== -1) {
        state.providers[index] = { ...state.providers[index], ...action.payload.updates }
      }
    }
  }
})

export const { setDefaultPreprocessProvider, updatePreprocessProviders, updatePreprocessProvider } =
  preprocessSlice.actions

export default preprocessSlice.reducer
