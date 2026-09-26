import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import ModelSelector from '@renderer/components/ModelSelector'
import { useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId } from '@renderer/services/ModelService'
import type { Model as ForkModel, Provider as ForkProvider } from '@renderer/types'
import type { UniqueModelId } from '@shared/types/uniqueModelId'
import { parseUniqueModelId } from '@shared/types/uniqueModelId'

import { toCliModel, type Model } from '../../cliConfig/providerView'
import { isUniqueModelId, safeCreateUniqueModelId } from '../../cliConfig/values'

// fork 缝（批次4b 原创缝模块，configEditPanel 的模型选择面）：V2 的 ModelSelector 为自绘
// popup + 自定义 trigger（ModelSelectorTrigger.tsx，未单独移植——antd Select 无自定义 trigger
// 面）。本模块以 fork 既有 ModelSelector（antd Select 封装）对号：filter 谓词经 toCliModel 投影
// 回 V2 面、值面在 UniqueModelId（"provider::id"）与 fork getModelUniqId（JSON 串）间换算，
// 选中项视觉（avatar + 名称）经 antd labelRender 等值保留。V2 的 showTagFilter/onSettingsNavigate
// 面随 fork 的 ModelSelector 能力面裁掉。

interface ModelSelectProps {
  value?: UniqueModelId
  placeholder?: string
  filter: (model: Model) => boolean
  onSelect: (modelId: UniqueModelId | undefined) => void
  disabled?: boolean
}

export function ModelSelect({ value, placeholder, filter, onSelect, disabled }: ModelSelectProps) {
  const { providers } = useProviders()

  // fork 缝（续）：fork 模型 → V2 投影面（id 保持 raw id，providerId 由 toCliModel 直取）。
  const predicate = (forkModel: ForkModel): boolean => filter(toCliModel(forkModel))

  return (
    <ModelSelector
      providers={providers}
      predicate={predicate}
      showAvatar={false}
      disabled={disabled}
      placeholder={placeholder}
      style={{ width: '100%' }}
      value={value ? (forkModelKeyByUniqueModelId(providers, value) ?? value) : undefined}
      labelRender={({ value: selectedKey }) => {
        const model = findForkModelByKey(providers, typeof selectedKey === 'string' ? selectedKey : undefined)
        if (model) {
          return (
            <div className="flex min-w-0 items-center gap-2">
              <ModelAvatar model={model} size={18} />
              <span className="truncate">{model.name || model.id}</span>
            </div>
          )
        }
        if (typeof selectedKey === 'string' && isUniqueModelId(selectedKey)) {
          return <span className="truncate">{parseUniqueModelId(selectedKey).modelId}</span>
        }
        return <span className="truncate text-muted-foreground">{placeholder}</span>
      }}
      onChange={(next) => {
        if (!next) {
          onSelect(undefined)
          return
        }
        const model = findForkModelByKey(providers, String(next))
        const uniqueModelId = model ? safeCreateUniqueModelId(model.provider, model.id) : undefined
        if (uniqueModelId) onSelect(uniqueModelId)
      }}
      allowClear
    />
  )
}

// fork 缝（续）：UniqueModelId → fork 选择器键（getModelUniqId 的 JSON 串）；无命中回落原串
//（antd Select 按原值显示，labelRender 里再按 UniqueModelId 面解析）。
function forkModelKeyByUniqueModelId(providers: ForkProvider[], uniqueModelId: UniqueModelId): string | undefined {
  for (const provider of providers) {
    for (const model of provider.models) {
      if (safeCreateUniqueModelId(model.provider, model.id) === uniqueModelId) {
        return getModelUniqId(model)
      }
    }
  }
  return undefined
}

function findForkModelByKey(providers: ForkProvider[], key: string | undefined): ForkModel | undefined {
  if (!key) return undefined
  for (const provider of providers) {
    for (const model of provider.models) {
      if (getModelUniqId(model) === key) return model
    }
  }
  return undefined
}
