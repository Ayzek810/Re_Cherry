import { CloseCircleFilled } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import CodeEditor from '@renderer/components/CodeEditor'
import EmojiPicker from '@renderer/components/EmojiPicker'
import { DeleteIcon } from '@renderer/components/Icons'
import { HSpaceBetweenStack, HStack } from '@renderer/components/Layout'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isChatCandidateModel } from '@renderer/config/models'
import useAssistantIdentityImage from '@renderer/hooks/useAssistantIdentityImage'
import { usePromptProcessor } from '@renderer/hooks/usePromptProcessor'
import { createIdentityImage, releaseIdentityImage } from '@renderer/services/assistantIdentity'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { Assistant, AssistantSettings, Model } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import { Button, Input, Popover, Segmented, Upload } from 'antd'
import { Edit, HelpCircle, ImagePlus, PlusIcon, Save } from 'lucide-react'
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
  const [uploading, setUploading] = useState(false)
  const identityImageUrl = useAssistantIdentityImage(emoji)

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

  /**
   * 标识单路径写入（v0.3.1 功能一）：库选 emoji 与 `img:` 图片引用都落在 assistant.emoji 上；
   * 被替换的图片标识在再无引用时回收。
   */
  const applyIdentity = (next: string) => {
    const previous = assistant.emoji
    setEmoji(next)
    persistIdentity(name.trim(), next)
    if (next !== previous) {
      void releaseIdentityImage(previous)
    }
  }

  const handleNameBlur = () => {
    const nextName = name.trim()
    if (nextName === assistant.name.replace(getLeadingEmoji(assistant.name) || '', '').trim()) return
    persistIdentity(nextName, emoji)
  }

  const handleEmojiSelect = (selectedEmoji: string) => {
    applyIdentity(selectedEmoji)
  }

  const handleEmojiDelete = () => {
    applyIdentity('')
  }

  const handleImageSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      window.toast.error(t('assistants.settings.identity.image_invalid'))
      return
    }
    setUploading(true)
    try {
      applyIdentity(await createIdentityImage(file))
    } catch {
      window.toast.error(t('assistants.settings.identity.image_failed'))
    } finally {
      setUploading(false)
    }
  }

  const modelFilter = (model: Model) => isChatCandidateModel(model)

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
          <Popover
            content={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Upload
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void handleImageSelect(file)
                    return false
                  }}>
                  <Button icon={<ImagePlus size={14} />} loading={uploading} style={{ width: '100%' }}>
                    {t('assistants.settings.identity.image')}
                  </Button>
                </Upload>
                <EmojiPicker onEmojiClick={handleEmojiSelect} />
              </div>
            }
            arrow
            trigger="click">
            <EmojiButtonWrapper>
              <Button style={{ fontSize: 18, padding: '4px', minWidth: '28px', height: '28px' }}>
                {identityImageUrl ? (
                  <img
                    src={identityImageUrl}
                    alt=""
                    style={{ width: 20, height: 20, borderRadius: 10, objectFit: 'cover', verticalAlign: 'middle' }}
                  />
                ) : (
                  emoji
                )}
              </Button>
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

      {/* 功能二：本助手对话页显示"模型信息"（默认）还是"助手信息"，两挡选择，不进全局设置 */}
      <SettingsItem inline>
        <SettingsTitle>{t('assistants.settings.display.label')}</SettingsTitle>
        <Segmented
          shape="round"
          value={assistant.settings?.messageIdentity ?? 'model'}
          onChange={(value) =>
            updateAssistantSettings({ messageIdentity: value as AssistantSettings['messageIdentity'] })
          }
          options={[
            { value: 'model', label: t('assistants.settings.display.model') },
            { value: 'assistant', label: t('assistants.settings.display.assistant') }
          ]}
        />
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
