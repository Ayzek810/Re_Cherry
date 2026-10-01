import { isAnthropicModel, isChatCandidateModel, isGeminiModel } from '@renderer/config/models'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { getProviderByModel } from '@renderer/services/AssistantService'
import { isSupportUrlContextProvider } from '@renderer/utils/provider'

import UrlContextButton from './components/UrlContextbutton'

const urlContextTool = defineTool({
  key: 'url_context',
  label: (t) => t('chat.input.url_context'),
  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => {
    // `getProviderByModel` 查不到时返回 `undefined`（不再回落到任意 provider）。
    // 本工具按「provider 未知 ⇒ 不显示按钮」处理；`!!provider` 同时完成类型窄化。
    const provider = getProviderByModel(model)
    return (
      !!provider &&
      isSupportUrlContextProvider(provider) &&
      isChatCandidateModel(model) &&
      (isGeminiModel(model) || isAnthropicModel(model))
    )
  },
  render: ({ assistant }) => <UrlContextButton assistantId={assistant.id} />
})

registerTool(urlContextTool)

export default urlContextTool
