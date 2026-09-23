// fork 缝：V2 `pages/paintings/components/PaintingComposer.tsx` 全文逐字搬运（345 行），
// 仅 import 段换 fork 等价件 + L197-198 的 `usePreference` 换成 `useSettings`（fork 无
// usePreference 数据层），两处均在下文逐条标注；其余段落与 V2 逐字一致。
import ComposerSurface from '@renderer/components/composer/ComposerSurface'
import {
  ComposerToolDerivedStateProvider,
  ComposerToolRuntimeHost,
  ComposerToolRuntimeProvider,
  useComposerTokenReconcile,
  useComposerToolDispatch,
  useComposerToolLauncherActions,
  useComposerToolLauncherVersion,
  useComposerToolState
} from '@renderer/components/composer/ComposerToolRuntime'
import type { ComposerDraftToken } from '@renderer/components/composer/tokens'
import { getComposerToolConfig } from '@renderer/components/composer/tools/registry'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@renderer/components/composer/ui'
// fork 缝：V2 从 `./PaintingImageGallery` / `./PaintingModelSelector` 引页部件；
// fork 这两个原件是 props 驱动且页面还在用，故改引 composer 缝里的同义替身。
import {
  PaintingImageAddButton,
  PaintingImageGallery
} from '@renderer/components/composer/variants/painting/PaintingImageGallery'
import PaintingModelSelector from '@renderer/components/composer/variants/painting/PaintingModelSelector'
import {
  COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS,
  COMPOSER_SELECTOR_BUTTON_CLASS,
  ComposerToolbarControls
} from '@renderer/components/composer/variants/shared/ComposerControlScaffolding'
import { fileToComposerToken } from '@renderer/components/composer/variants/shared/composerTokens'
import { useSettings } from '@renderer/hooks/useSettings'
import { supportsPaintingEdit } from '@renderer/services/paintingModelSelection'
import { useAppSelector } from '@renderer/store'
import type { Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types/file'
import { cn } from '@renderer/utils/style'
import { imageExts } from '@shared/config/constant'
import { getImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
import { Settings2 } from 'lucide-react'
import { type FC, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { BaseConfigItem } from '../form/baseConfigItem'
import { imageGenerationToFields } from '../form/imageGenerationToFields'
import { SIZE_PREVIEW_KEYS, sizeOptionLabel } from '../form/paintingSize'
import { resolveOptions } from '../form/resolveOptions'
import { type InputCapability, usePaintingComposerInputFiles } from '../hooks/usePaintingComposerInputFiles'
import type { MaterializeInputs } from '../hooks/usePaintingGenerationSubmit'
import type { PaintingData } from '../model/types/paintingData'
import { tabToImageGenerationMode } from '../utils/paintingProviderMode'
import PaintingSettings from './PaintingSettings'

const PAINTING_MANAGED_TOKEN_KINDS: readonly ComposerDraftToken['kind'][] = ['file']
// Edit-image models render their inputs via the top reference-image tray, not file
// pills, so the composer manages no tokens then (empty set = no doc token reconcile).
const PAINTING_NO_MANAGED_TOKEN_KINDS: readonly ComposerDraftToken['kind'][] = []
const EMPTY_TOKENS: readonly ComposerDraftToken[] = []
const PAINTING_IMAGE_EXTS = imageExts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
const PAINTING_SCOPE = 'painting' as const

/** Field types worth surfacing in the compact button summary. */
const SUMMARY_TYPES = new Set<BaseConfigItem['type']>([
  'select',
  'sizeChips',
  'slider',
  'radio',
  'iconRadio',
  'styleToggle'
])

function formatSummaryValue(
  item: BaseConfigItem,
  value: unknown,
  params: PaintingData['params'],
  translate: (key: string) => string
): string | undefined {
  // Size-bearing fields render as chip-style dimensions, matching the size chips.
  if ((SIZE_PREVIEW_KEYS as readonly string[]).includes(item.key ?? '')) {
    if (value === 'custom') {
      const w = params?.customSize_width
      const h = params?.customSize_height
      return w && h ? `${String(w)}×${String(h)}` : undefined
    }
    // Localize the selected option (e.g. `auto` → `自动`) the same way the chips
    // and the artboard prompt bar do, instead of formatting the raw enum.
    return sizeOptionLabel(item, String(value), params, translate)
  }
  if (item.type === 'slider') return String(value)
  // Option-based: show the selected option's localized label.
  const match = resolveOptions(item, params ?? {}, translate).find((opt) => String(opt.value) === String(value))
  return match?.label ?? String(value)
}

/**
 * Compact summary of the current parameter selection, shown on the params button so
 * the popover's choices are visible at a glance. Mirrors the form: each field's
 * effective value is `params[key] ?? item.initialValue` (PaintingFieldRenderer), so
 * registry defaults appear before the user explicitly changes them.
 */
function paramsSummary(
  params: PaintingData['params'],
  items: BaseConfigItem[],
  translate: (key: string) => string
): string {
  const parts: string[] = []
  for (const item of items) {
    if (!item.key || !SUMMARY_TYPES.has(item.type)) continue
    if (item.condition && !item.condition(params ?? {})) continue
    const value = params?.[item.key] ?? item.initialValue
    if (value === undefined || value === null || value === '') continue
    const formatted = formatSummaryValue(item, value, params, translate)
    if (formatted) parts.push(formatted)
  }
  return parts.join(' · ')
}

export interface PaintingComposerProps {
  painting: PaintingData
  /** Data-derived: a generation is running for this painting (possibly resumed). */
  generating: boolean
  /** Action-scoped: a send started here is in flight. Owned by usePaintingGenerationSubmit. */
  submitting: boolean
  onPromptChange: (value: string) => void
  /**
   * Hands the request its input resolver. The composer holds the draft attachments
   * but does not orchestrate the request — materialization is the request's first
   * step, run by its owner only once the preconditions pass.
   */
  onGenerate: (materialize: MaterializeInputs) => void | Promise<void>
  onCancel: () => void
  onModelSelect: (selection: { providerId: string; modelId: string }) => void
  onConfigChange: (updates: Partial<PaintingData>) => void
  onGenerateRandomSeed?: (key: string) => void
}

/** Bottom-toolbar popover hosting the image-generation parameter list. */
const PaintingParamsButton: FC<{
  painting: PaintingData
  onConfigChange: (updates: Partial<PaintingData>) => void
  onGenerateRandomSeed?: (key: string) => void
  /** fork 缝（v0.3.3-7）：工具栏放不下时进图标态（V2 同源）——只留齿轮，参数摘要是按钮的 aria-label。 */
  iconOnly?: boolean
}> = ({ painting, onConfigChange, onGenerateRandomSeed, iconOnly }) => {
  const { t } = useTranslation()
  // fork 缝（v0.3.3 批次6）：support 从 fork 目录按 (providerId, model) 解析，
  // 字段面因此随模型能力变化（V2 是 useImageGenerationSupport 查询，同语义）。
  const support = useMemo(
    () => getImageGenerationSupport(painting.providerId, painting.model) ?? undefined,
    [painting.providerId, painting.model]
  )
  const configItems = useMemo(
    () => imageGenerationToFields(support, { mode: tabToImageGenerationMode(painting.mode) }),
    [support, painting.mode]
  )
  const summary = useMemo(() => paramsSummary(painting.params, configItems, t), [painting.params, configItems, t])

  if (configItems.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            COMPOSER_SELECTOR_BUTTON_CLASS,
            iconOnly && COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS,
            'text-muted-foreground'
          )}
          aria-label={summary ? `${t('common.settings')}: ${summary}` : t('common.settings')}>
          <Settings2 className="size-4" />
          {summary && !iconOnly && (
            <span className="max-w-55 truncate" title={summary}>
              {summary}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[min(300px,calc(100vw-2rem))] rounded-[8px] p-3">
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <PaintingSettings
            painting={painting}
            onConfigChange={onConfigChange}
            onGenerateRandomSeed={onGenerateRandomSeed}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface PaintingComposerInnerProps extends PaintingComposerProps {
  model?: Model
  couldAddImageFile: boolean
}

const PaintingComposerInner: FC<PaintingComposerInnerProps> = ({
  painting,
  generating,
  submitting,
  onPromptChange,
  onGenerate,
  onCancel,
  onModelSelect,
  onConfigChange,
  onGenerateRandomSeed,
  model,
  couldAddImageFile
}) => {
  const { t } = useTranslation()
  const { files, isExpanded } = useComposerToolState()
  const { setFiles, setIsExpanded } = useComposerToolDispatch()
  const { getLaunchers, dispatchLauncher } = useComposerToolLauncherActions()
  const toolLaunchersVersion = useComposerToolLauncherVersion()
  const text = painting.prompt ?? ''
  // fork 缝：V2 `usePreference('app.spell_check.enabled')` / `('chat.message.font_size')`
  // 在 fork 无 usePreference 数据层，改用 fork 既有 settings slice 的等价键
  // `enableSpellCheck` / `fontSize`（页面 Inputbar 同源）。
  const { enableSpellCheck, fontSize } = useSettings()
  const config = getComposerToolConfig(PAINTING_SCOPE)

  // `couldAddImageFile` is modality-based (isEditImageModel → inputModalities includes
  // image): whether the model takes an image at all. Whether an image is *required* —
  // the model can only edit, not generate from text — is the one thing modality can't
  // answer, so it reads the registry's modes (no `generate` mode ⇒ image mandatory).
  // fork 缝：V2 `useImageGenerationSupport(providerId, model)` 的 registry modes 在 fork
  // 无对应件；fork 的"纯编辑"等价信号是画作模式（`tabToImageGenerationMode(mode)` 非
  // 'generate'），与 V2 "无 generate 模式"同义。
  const imageRequired = couldAddImageFile && tabToImageGenerationMode(painting.mode) !== 'generate'
  // Gate on the composer's own `files` — the chips the user sees in the image tray.
  // `painting.inputFiles` is NOT usable here: inputs are materialized at generate time
  // (usePaintingComposerInputFiles), so during the draft it still holds the *previous*
  // run's entries. Reading it would leave a freshly-attached image invisible to the gate
  // (edit-only send stuck disabled forever) and would keep the gate open after the last
  // chip is removed. `canonicalGenerate` re-checks `EDIT_IMAGE_REQUIRED` on the
  // materialized entries, so this gate only has to match what the user can see.
  const draftImageCount = files.filter((file) => file.type === FILE_TYPE.IMAGE).length
  const missingRequiredImage = imageRequired && draftImageCount === 0

  const placeholder = !couldAddImageFile
    ? t('paintings.prompt_placeholder')
    : imageRequired
      ? t('paintings.prompt_placeholder_upload_required')
      : t('paintings.prompt_placeholder_upload')

  // `unknown` while the model is still resolving from the async catalog; `accept`
  // once it resolves to an edit-capable model, `reject` otherwise. Drives the
  // draft-clear on a model switch (see usePaintingComposerInputFiles CLEAR).
  const inputCapability: InputCapability = !model ? 'unknown' : couldAddImageFile ? 'accept' : 'reject'

  const { materializeInputs } = usePaintingComposerInputFiles({
    paintingId: painting.id,
    archivedInputFiles: painting.inputFiles ?? [],
    inputCapability,
    providerId: painting.providerId,
    // fork 缝（P0-A）：把作曲条读取的实时列表交给物化与 CLEAR——否则物化用的是本 hook
    // 自持、除挂载播种外无人写入的存档态（陈旧列表），chips 上的增删与它无关。
    files,
    setFiles
  })

  // Edit-image models: images live in the top reference-image tray (reads `files` from
  // context), so emit no file pills and manage no tokens — `files` stays authoritative.
  const tokens = useMemo(
    () => (couldAddImageFile ? EMPTY_TOKENS : files.map(fileToComposerToken)),
    [couldAddImageFile, files]
  )
  const handleTokensChange = useComposerTokenReconcile({ scope: PAINTING_SCOPE, model })

  const handleTextChange = useCallback((value: string) => onPromptChange(value), [onPromptChange])

  // The request is orchestrated by its owner (usePaintingGenerationSubmit), which
  // holds the re-entrancy guard and runs materialization only after the preconditions
  // pass. This composer reports intent and hands over the resolver; it deliberately
  // keeps no send state of its own.
  const handleSendDraft = useCallback(() => onGenerate(materializeInputs), [materializeInputs, onGenerate])

  return (
    <ComposerToolDerivedStateProvider couldAddImageFile={couldAddImageFile} extensions={PAINTING_IMAGE_EXTS}>
      {model && <ComposerToolRuntimeHost scope={PAINTING_SCOPE} model={model} />}
      <ComposerSurface
        text={text}
        onTextChange={handleTextChange}
        tokens={tokens}
        managedTokenKinds={couldAddImageFile ? PAINTING_NO_MANAGED_TOKEN_KINDS : PAINTING_MANAGED_TOKEN_KINDS}
        onTokensChange={handleTokensChange}
        topContent={couldAddImageFile ? <PaintingImageGallery /> : undefined}
        leadingContent={couldAddImageFile ? <PaintingImageAddButton /> : undefined}
        placeholder={placeholder}
        sendDisabled={
          generating || submitting || !model || (text.trim().length === 0 && files.length === 0) || missingRequiredImage
        }
        sendBlockedReason={missingRequiredImage ? t('paintings.edit.image_required') : undefined}
        isLoading={generating}
        onSendDraft={handleSendDraft}
        onPause={onCancel}
        supportedExts={PAINTING_IMAGE_EXTS}
        setFiles={setFiles}
        filesCount={files.length}
        isExpanded={isExpanded}
        onExpandedChange={setIsExpanded}
        quickPanelEnabled={config.enableQuickPanel ?? false}
        enableDragDrop={config.enableDragDrop ?? true}
        enableSpellCheck={enableSpellCheck}
        fontSize={fontSize}
        narrowMode
        getToolLaunchers={() => getLaunchers()}
        toolLaunchersVersion={toolLaunchersVersion}
        onToolLauncherSelect={(launcher, options) => dispatchLauncher(launcher, options)}
        renderLeftControls={(inputAdapter, unifiedPanelControl) => (
          <ComposerToolbarControls
            inputAdapter={inputAdapter}
            unifiedPanelControl={unifiedPanelControl}
            renderContextControls={({ iconOnly }) => (
              <>
                <PaintingModelSelector
                  hideTitle
                  iconOnly={iconOnly}
                  painting={painting}
                  onSelect={onModelSelect}
                  className={cn(
                    COMPOSER_SELECTOR_BUTTON_CLASS,
                    iconOnly
                      ? COMPOSER_ICON_ONLY_SELECTOR_BUTTON_CLASS
                      : 'w-auto max-w-[200px] border border-border-subtle'
                  )}
                />
                <PaintingParamsButton
                  iconOnly={iconOnly}
                  painting={painting}
                  onConfigChange={onConfigChange}
                  onGenerateRandomSeed={onGenerateRandomSeed}
                />
              </>
            )}
          />
        )}
      />
    </ComposerToolDerivedStateProvider>
  )
}

/**
 * The painting prompt bar, rebuilt on the shared `ComposerSurface`. The image-gen
 * model selector + parameter list live in the bottom toolbar; image inputs flow
 * through the composer attachment pipeline, bridged to the page's `FileEntry[]`.
 */
const PaintingComposer: FC<PaintingComposerProps> = (props) => {
  const { painting } = props
  const models = useAppSelector((state) => state.llm.providers)
  const model = useMemo(() => {
    // fork 缝：V2 `useModels({ providerId })` 是异步模型目录；fork 的模型目录就在 redux
    // providers 里，这里按 providerId 取该 provider 的模型并沿用 V2 的 id 匹配谓词。
    const list = painting.providerId
      ? (models.find((provider) => provider.id === painting.providerId)?.models ?? [])
      : models.flatMap((provider) => provider.models)
    return painting.model
      ? list.find((entry) => entry.provider === painting.providerId && entry.id === painting.model)
      : undefined
  }, [models, painting.providerId, painting.model])
  // fork 缝：V2 `isEditImageModel(model)`（@shared/utils/model）→ fork 的
  // `supportsPaintingEdit`（paintingModelSelection，同义谓词）。
  const couldAddImageFile = model ? supportsPaintingEdit(model) : false

  return (
    // Key the provider (which owns `files`) by painting id only: a different painting
    // is a different editing session and must reset + re-seed the draft. A model
    // switch must NOT remount — that would wipe an in-progress draft — so the
    // `switchModel` `inputFiles: []` clear is reconciled reactively instead (see
    // usePaintingComposerInputFiles CLEAR). Keying on the model here used to work only
    // because the removed writeback kept `painting.inputFiles === files`.
    <ComposerToolRuntimeProvider
      key={painting.id}
      initialState={{ files: [], couldAddImageFile, extensions: PAINTING_IMAGE_EXTS }}
      actions={{ addNewTopic: () => {}, onTextChange: () => {} }}>
      <PaintingComposerInner {...props} model={model} couldAddImageFile={couldAddImageFile} />
    </ComposerToolRuntimeProvider>
  )
}

export default PaintingComposer
