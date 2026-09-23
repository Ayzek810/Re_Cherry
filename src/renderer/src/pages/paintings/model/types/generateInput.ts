/**
 * paintingGenerate 入参形状（v0.3.3 批次4，② 薄适配）：V2 generateInput.ts
 * 去掉 DataApi/tab 字段——provider 直接用 fork Provider 行（enabled/apiKey 在
 * redux 里），abortController 保留（requestId 取消经 lightImageAbort）。
 */
import type { Provider } from '@renderer/types'

import type { PaintingData } from './paintingData'

export interface GenerateInput<T extends PaintingData = PaintingData> {
  painting: T
  provider: Provider
  abortController: AbortController
}
