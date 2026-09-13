import { CloseCircleFilled } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import CodeEditor from '@renderer/components/CodeEditor'
import EmojiPicker from '@renderer/components/EmojiPicker'
import { DeleteIcon } from '@renderer/components/Icons'
import { HSpaceBetweenStack, HStack } from '@renderer/components/Layout'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { usePromptProcessor } from '@renderer/hooks/usePromptProcessor'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { Assistant, AssistantSettings, Model } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import { Button, Input, Popover } from 'antd'
import { Edit, HelpCircle, PlusIcon, Save } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import styled from 'styled-components'

import { SettingsContainer, SettingsItem, SettingsTitle } from '../shared'
import ChatSettingsSection from './ChatSettingsSection'

interface Props {
  assistant: Assistant
  updateAssistant: (update: Partial<Omit<Assistant, 'id'>>) => void
  updateAssistantSettings: (settings: Partial<AssistantSettings>) => void
}

/**
 * 基础页（v0.3.0 验收调整）：原"提示词"页栏目并入本页——
 * 名称/emoji + 默认模型 + 提示词编辑器 + 聊天设置（平铺，无折叠项），区块标题统一对齐。
 */
const EssentialSettings: FC<Props> = ({ assistant, updateAssistant, updateAssistantSettings }) => {
  const { t } = useTranslation()
  const [emoji, setEmoji] = useState(assistant.emoji || getLeadingEmoji(assistant.name) || '')
  const [name, setName] = useState(assistant.name.replace(getLeadingEmoji(assistant.name) || '', '').trim())

  const [prompt, setPrompt] = useState(assistant.prompt)
  const [showPreview, setShowPreview] = useState(false)
  const [tokenCount, setTokenCount] = useState(0)

  const defaultModel = assistant.model ?? assistant.defaultModel

  useEffect(() => {
    setTokenCount(estimateTextTokens(prompt))
  }, [prompt])

  const processedPrompt = usePromptProcessor({
    prompt,
    modelName: assistant.model?.name
  })

  const persistIdentity = (nextName: string, nextEmoji: string) => {
    updateAssistant({ name: nextName, emoji: nextEmoji })
  }

  const handleNameBlur = () => {
    const nextName = name.trim()
    if (nextName === assistant.name.replace(getLeadingEmoji(assistant.name) || '', '').trim()) return
    persistIdentity(nextName, emoji)
  }

  const handleEmojiSelect = (selectedEmoji: string) => {
    setEmoji(selectedEmoji)
    persistIdentity(name.trim(), selectedEmoji)
  }

  const handleEmojiDelete = () => {
    setEmoji('')
    persistIdentity(name.trim(), '')
  }

  const modelFilter = (model: Model) => !isEmbeddingModel(model) && !isRerankModel(model)

  const onSelectModel = async () => {
    const selectedModel = await SelectChatModelPopup.show({ model: defaultModel, filter: modelFilter })
    if (selectedModel) {
      updateAssistant({ model: selectedModel, defaultModel: selectedModel })
    }
  }

  const promptVarsContent = <pre>{t('assistants.presets.add.prompt.variables.tip.content')}</pre>

  return (
    <SettingsContainer>
      <SettingsItem inline>
        <SettingsTitle>{t('common.name')}</SettingsTitle>
        <HStack alignItems="center" gap={8} style={{ minWidth: 0, flex: 1, justifyContent: 'flex-end' }}>
          <Popover content={<EmojiPicker onEmojiClick={handleEmojiSelect} />} arrow trigger="click">
            <EmojiButtonWrapper>
              <Button style={{ fontSize: 18, padding: '4px', minWidth: '28px', height: '28px' }}>{emoji}</Button>
              {emoji && (
                <CloseCircleFilled
                  className="delete-icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleEmojiDelete()
                  }}
                  style={{
                    display: 'none',
                    position: 'absolute',
                    top: '-8px',
                    right: '-8px',
                    fontSize: '16px',
                    color: '#ff4d4f',
                    cursor: 'pointer'
                  }}
                />
              )}
            </EmojiButtonWrapper>
          </Popover>
          <Input
            placeholder={t('common.assistant') + t('common.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleNameBlur}
            style={{ maxWidth: 320 }}
          />
        </HStack>
      </SettingsItem>

      <SettingsItem inline>
        <SettingsTitle>{t('assistants.settings.default_model')}</SettingsTitle>
        <HStack alignItems="center" gap={5}>
          <ModelSelectButton
            icon={defaultModel ? <ModelAvatar model={defaultModel} size={20} /> : <PlusIcon size={18} />}
            onClick={onSelectModel}>
            <ModelName>{defaultModel ? defaultModel.name : t('assistants.presets.edit.model.select.title')}</ModelName>
          </ModelSelectButton>
          {defaultModel && (
            <Button
              color="danger"
              variant="filled"
              icon={<DeleteIcon size={14} className="lucide-custom" />}
              onClick={() => updateAssistant({ model: undefined, defaultModel: undefined })}
              danger
            />
          )}
        </HStack>
      </SettingsItem>

      <SettingsItem>
        <SettingsTitle contentAfter={<HelpCircle size={14} color="var(--color-text-2)" />}>
          <Popover title={t('assistants.presets.add.prompt.variables.tip.title')} content={promptVarsContent}>
            <PromptTitleButton>{t('common.prompt')}</PromptTitleButton>
          </Popover>
        </SettingsTitle>
        <PromptEditorContainer>
          {showPreview ? (
            <MarkdownContainer onDoubleClick={() => setShowPreview(false)}>
              <ReactMarkdown>{processedPrompt || prompt}</ReactMarkdown>
            </MarkdownContainer>
          ) : (
            <CodeEditor
              value={prompt}
              language="markdown"
              onChange={setPrompt}
              height="100%"
              expanded={false}
              style={{ height: '100%' }}
            />
          )}
        </PromptEditorContainer>
        <HSpaceBetweenStack width="100%" justifyContent="flex-end" mt="8px">
          <TokenCount>Tokens: {tokenCount}</TokenCount>
          <Button
            type="primary"
            icon={showPreview ? <Edit size={14} /> : <Save size={14} />}
            onClick={() => {
              if (showPreview) {
                setShowPreview(false)
              } else {
                updateAssistant({ prompt })
                setShowPreview(true)
                window.toast.success(t('common.saved'))
              }
            }}>
            {showPreview ? t('common.edit') : t('common.save')}
          </Button>
        </HSpaceBetweenStack>
      </SettingsItem>

      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.chatSettings.title')}</SettingsTitle>
        <ChatSettingsSection assistant={assistant} updateAssistantSettings={updateAssistantSettings} />
      </SettingsItem>
    </SettingsContainer>
  )
}

const EmojiButtonWrapper = styled.div`
  position: relative;
  display: inline-block;

  &:hover .delete-icon {
    display: block !important;
  }
`

const PromptTitleButton = styled.span`
  cursor: help;
`

const ModelSelectButton = styled(Button)`
  max-width: 300px;
  justify-content: flex-start;

  .ant-btn-icon {
    flex-shrink: 0;
  }
`

const ModelName = styled.span`
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
`

const PromptEditorContainer = styled.div`
  height: 220px;
  border: 0.5px solid var(--color-border);
  border-radius: 5px;
  overflow: hidden;

  .prompt-rich-editor {
    border: none;
    height: 100%;

    .rich-editor-wrapper {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .rich-editor-content {
      flex: 1;
      overflow: auto;
    }
  }
`

const MarkdownContainer = styled.div.attrs({ className: 'markdown' })`
  height: 100%;
  padding: 0.5em;
  overflow: auto;
`

const TokenCount = styled.div`
  padding: 2px 2px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--color-text-2);
  user-select: none;
`

export default EssentialSettings
