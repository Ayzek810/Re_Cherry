import { useAssistant } from '@renderer/hooks/useAssistant'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import type { KnowledgeBase } from '@renderer/types'
import { useCallback } from 'react'

import KnowledgeBaseButton from './components/KnowledgeBaseButton'

/**
 * Knowledge Base Tool（v0.3.2 自 CS_V1 移植）
 *
 * Allows users to select knowledge bases to provide context for their messages.
 * 批次1 仅为 UI 开关（写 assistant.knowledge_bases）；检索注入批次4 接线。
 * V1 的 isSupportedToolUse/isPromptToolUse 条件属上游工具面模式判据，fork 未保留，不移植。
 */
const knowledgeBaseTool = defineTool({
  key: 'knowledge_base',
  label: (t) => t('chat.input.knowledge_base'),

  visibleInScopes: [TopicType.Chat],

  dependencies: {
    state: ['selectedKnowledgeBases', 'files'] as const,
    actions: ['setSelectedKnowledgeBases'] as const
  },

  render: function KnowledgeBaseToolRender(context) {
    const { assistant, state, actions, quickPanel } = context

    const { updateAssistant } = useAssistant(assistant.id)

    const handleSelect = useCallback(
      (bases: KnowledgeBase[]) => {
        updateAssistant({ knowledge_bases: bases })
        actions.setSelectedKnowledgeBases?.(bases)
      },
      [updateAssistant, actions]
    )

    return (
      <KnowledgeBaseButton
        quickPanel={quickPanel}
        selectedBases={state.selectedKnowledgeBases}
        onSelect={handleSelect}
        disabled={Array.isArray(state.files) && state.files.length > 0}
      />
    )
  }
})

registerTool(knowledgeBaseTool)

export default knowledgeBaseTool
