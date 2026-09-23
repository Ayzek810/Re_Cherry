/**
 * 绘画提示词栏（v0.3.3 批次4 重写 / v0.3.3-2 参数入口改回 V2 形态）：
 * Input.TextArea + 参考图托盘（usePaintingComposerInputFiles）+ 模型按钮
 * （PaintingModelSelector → SelectChatModelPopup）+ **参数 Popover**（V2 PaintingParamsButton
 * 语义：点开即是 PaintingSettings 表单，不再是页面级抽屉）。
 * V2 L218-222 placeholder 三态与 L266-269 send 阻断语义照抄。
 */
import { LoadingOutlined, SettingOutlined } from '@ant-design/icons'
import { PaintingImageAddButton, PaintingInputTray } from '@renderer/pages/paintings/components/PaintingImageGallery'
import PaintingModelSelector, { type PaintingModelSelection } from '@renderer/pages/paintings/components/PaintingModelSelector'
import PaintingSettings from '@renderer/pages/paintings/components/PaintingSettings'
import type { usePaintingComposerInputFiles } from '@renderer/pages/paintings/hooks/usePaintingComposerInputFiles'
import type { MaterializeInputs } from '@renderer/pages/paintings/hooks/usePaintingGenerationSubmit'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import type { Model } from '@renderer/types'
import { Button, Input, Popover, Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export interface PaintingComposerProps {
  painting: PaintingData
  /** 数据派生：该画有在途生成。 */
  generating: boolean
  /** 动作域：本次 send 在途。 */
  submitting: boolean
  /** 当前绘画模型（页面注入；提示条只读回显）。 */
  model: Model | undefined
  onPromptChange: (value: string) => void
  onGenerate: (materialize: MaterializeInputs) => void
  onCancel: () => void
  onModelSelect: (selection: PaintingModelSelection) => void
  /** 参数 Popover 的写侧（V2：PaintingSettings 直接挂提示条内）。 */
  onConfigChange: (updates: Partial<PaintingData>) => void
  onGenerateRandomSeed: (key: string) => void
  /** 参考图托盘状态由页面持有（跨 painting 存档/回灌），经 props 注入。 */
  tray: ReturnType<typeof usePaintingComposerInputFiles>
}

/** V2 L218-222 placeholder 三态：无图能力 / 必须传图 / 可选传图。 */
function resolvePlaceholder(couldAddImageFile: boolean, imageRequired: boolean, t: (key: string) => string): string {
  if (!couldAddImageFile) return t('paintings.prompt_placeholder')
  return imageRequired ? t('paintings.prompt_placeholder_upload_required') : t('paintings.prompt_placeholder_upload')
}

const PaintingComposer: FC<PaintingComposerProps> = ({
  painting,
  generating,
  submitting,
  model,
  onPromptChange,
  onGenerate,
  onCancel,
  onModelSelect,
  onConfigChange,
  onGenerateRandomSeed,
  tray
}) => {
  const { t } = useTranslation()
  const text = painting.prompt ?? ''

  // couldAddImageFile：模型是否收图（supportsPaintingEdit 在选择器侧消化，此处
  // 由页面传入的 inputCapability 派生）；imageRequired：纯编辑模型必须有图。
  const couldAddImageFile = tray.inputCapability === 'accept'
  const imageRequired = couldAddImageFile && painting.mode !== 'generate'
  const draftImageCount = tray.inputFiles.length
  const missingRequiredImage = imageRequired && draftImageCount === 0
  const placeholder = resolvePlaceholder(couldAddImageFile, imageRequired, t)

  // V2 L266-269 send 阻断：生成中/提交中/无模型/空内容/缺必传图。
  const sendDisabled =
    generating || submitting || !model || (text.trim().length === 0 && tray.inputFiles.length === 0) || missingRequiredImage

  const handleSend = useCallback(() => {
    onGenerate(tray.materializeInputs)
  }, [onGenerate, tray])

  return (
    <ComposerWrap>
      {couldAddImageFile && (
        <TrayRow>
          <PaintingImageAddButton onPick={() => void tray.pickImages()} selecting={tray.selecting} />
          <PaintingInputTray files={tray.inputFiles} onRemove={tray.removeFile} />
        </TrayRow>
      )}
      <PromptRow>
        <PromptTextArea
          value={text}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={placeholder}
          variant="borderless"
          autoSize={{ minRows: 1, maxRows: 6 }}
          onPressEnter={(event) => {
            if (!event.shiftKey && !sendDisabled) {
              event.preventDefault()
              handleSend()
            }
          }}
        />
        <Controls>
          <PaintingModelSelector model={model} onSelect={onModelSelect} />
          {/* V2 PaintingParamsButton：参数表单挂 Popover（align=start/side=top，宽度 min(300px, 100vw-2rem)）。 */}
          <Popover
            trigger="click"
            placement="topLeft"
            arrow={false}
            content={
              <div className="flex max-h-[60vh] w-[min(300px,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto p-1">
                <PaintingSettings
                  painting={painting}
                  onConfigChange={onConfigChange}
                  onGenerateRandomSeed={onGenerateRandomSeed}
                />
              </div>
            }>
            <Tooltip title={t('common.settings')}>
              <Button type="text" icon={<SettingOutlined />} aria-label={t('common.settings')} />
            </Tooltip>
          </Popover>
          {generating ? (
            <Tooltip title={t('common.stop')}>
              <Button danger icon={<LoadingOutlined />} onClick={onCancel} aria-label={t('common.stop')} />
            </Tooltip>
          ) : (
            <Tooltip title={missingRequiredImage ? t('paintings.edit.image_required') : t('paintings.generate')}>
              <Button type="primary" disabled={sendDisabled} loading={submitting} onClick={handleSend}>
                {t('paintings.generate')}
              </Button>
            </Tooltip>
          )}
        </Controls>
      </PromptRow>
      {missingRequiredImage && <BlockedHint>{t('paintings.edit.image_required')}</BlockedHint>}
    </ComposerWrap>
  )
}

const ComposerWrap = styled.div`
  border: 0.5px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
  padding: 4px 8px 8px;
`

const TrayRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 4px 0;
`

const PromptRow = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 8px;
`

const PromptTextArea = styled(Input.TextArea)`
  flex: 1;
  min-width: 0;

  .ant-input {
    font-size: 14px;
  }
`

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-bottom: 2px;
`

const BlockedHint = styled.div`
  padding: 2px 8px 0;
  font-size: 12px;
  color: var(--color-status-warning);
`

export default PaintingComposer
