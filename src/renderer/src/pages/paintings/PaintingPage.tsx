// fork 缝：V2 PaintingPage.tsx 逐字搬运；仅 import 与数据缝改动，逐条见交接报告。
// 会话态/生成镜像/参考图托盘改由 PaintingSessionContext 提供（V2 为页面内 useState + useCache）。
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import Artboard from '@renderer/pages/paintings/components/Artboard'
import PaintingComposer from '@renderer/pages/paintings/components/PaintingComposer'
import PaintingStrip from '@renderer/pages/paintings/components/PaintingStrip'
import PaintingTemplateShowcase from '@renderer/pages/paintings/components/PaintingTemplateShowcase'
import { PaintingSessionProvider, usePaintingSession } from '@renderer/pages/paintings/context/PaintingSessionContext'
import { usePaintingGenerationSubmit } from '@renderer/pages/paintings/hooks/usePaintingGenerationSubmit'
import { usePaintingHistory } from '@renderer/pages/paintings/hooks/usePaintingHistory'
import { usePaintingInitialDraft } from '@renderer/pages/paintings/hooks/usePaintingInitialDraft'
import { usePaintingList } from '@renderer/pages/paintings/hooks/usePaintingList'
import { usePaintingModelCatalog } from '@renderer/pages/paintings/hooks/usePaintingModelCatalog'
import { usePaintingModelSwitch } from '@renderer/pages/paintings/hooks/usePaintingModelSwitch'
import { usePaintingProviderOptions } from '@renderer/pages/paintings/hooks/usePaintingProviderOptions'
import { usePaintingResultSync } from '@renderer/pages/paintings/hooks/usePaintingResultSync'
import { usePaintingTemplateCatalog } from '@renderer/pages/paintings/hooks/usePaintingTemplateCatalog'
import { createDefaultPainting, type PaintingDraftDefaults } from '@renderer/pages/paintings/model/paintingPipeline'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { sessionToPaintingGenerationState } from '@renderer/pages/paintings/model/utils/paintingGenerationParams'
import { paintingClasses } from '@renderer/pages/paintings/paintingPrimitives'
import { useAppSelector } from '@renderer/store'
import { type FC, useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const PaintingPage: FC = () => {
  const providerOptions = usePaintingProviderOptions()

  // fork 缝：Provider 必须挂在 usePaintingSession() 读取方之上，故页面拆 wrapper + 本体。
  return (
    <PaintingSessionProvider
      initialPainting={createDefaultPainting({ providerId: providerOptions[0]?.value ?? '' })}>
      <PaintingPageView />
    </PaintingSessionProvider>
  )
}

const PaintingPageView: FC = () => {
  const { t } = useTranslation()
  const { templates: promptPresets } = usePaintingTemplateCatalog()
  // fork 缝：V2 `useState` + `patchPainting` → 会话上下文（usePaintingSession）。
  const { currentPainting, setCurrentPainting, patchPainting, generationStateById } = usePaintingSession()
  // fork 缝：V2 usePaintingDraftDefaults 读 Preference feature.paintings.default_model_id；
  // fork 读 redux llm.paintingModel（设置页写入，父会话负责）。
  const paintingModel = useAppSelector((state) => state.llm.paintingModel)
  const providers = useAppSelector((state) => state.llm.providers)
  // fork 缝：V2 播种前用 isAvailablePaintingModel/resolvePaintingProvider 校验配置模型；fork 无该门，
  // 这里做等价校验（provider 在册且启用、模型在其模型表内），解析不到就只播种 provider——否则草稿里
  // 会留下解析不到的 painting.model，作曲条 model=undefined 会导致发送被永久禁用。
  const draftDefaults = useMemo<PaintingDraftDefaults>(() => {
    const configuredProvider = paintingModel
      ? providers.find((provider) => provider.id === paintingModel.provider && provider.enabled !== false)
      : undefined
    const modelAvailable =
      configuredProvider !== undefined && configuredProvider.models.some((model) => model.id === paintingModel?.id)
    return {
      providerId: paintingModel?.provider ?? currentPainting.providerId,
      ...(modelAvailable ? { modelId: paintingModel?.id } : {})
    }
  }, [paintingModel, providers, currentPainting.providerId])

  const history = usePaintingHistory()

  usePaintingInitialDraft({
    currentPainting,
    draftDefaults,
    setCurrentPainting
  })

  // Backfill a background generation's output files when they only reached
  // refreshed history (its completion couldn't update the no-longer-visible
  // draft), so the Artboard reveal doesn't strand on a permanent skeleton.
  usePaintingResultSync({ currentPainting, historyItems: history.items, setCurrentPainting })

  // Rehydrate the running spinner after a page switch: the cache mirror of
  // generation state survives unmount, so re-mounting picks it back up.
  // fork 缝：V2 `useCache('painting.generation.<id>')` + `cacheToPaintingGenerationState`
  // → 会话镜像 `generationStateById` + `sessionToPaintingGenerationState`（同为"缺席即空态"投影）。
  const liveGenerationState = useMemo(
    () => sessionToPaintingGenerationState(generationStateById.get(currentPainting.id) ?? null),
    [generationStateById, currentPainting.id]
  )

  // fork 缝：V2 `usePaintingModelCatalog({ providerOptions, painting })` → fork 签名为
  // `(providerId, selectedModelId)`；返回值无 currentModelOptions/ensureCurrentCatalog。
  const modelCatalog = usePaintingModelCatalog(currentPainting.providerId, currentPainting.model)

  // Historical model-less rows and drafts without a valid configured default
  // still need a usable view fallback. New drafts receive the configured model
  // as stored in-memory state before reaching this path.
  // fork 缝：V2 `currentModelOptions.find(option => option.isEnabled !== false)` 的逐模型
  // isEnabled 在 fork 无此概念（模型表来自 redux providers，已按 provider.enabled 过滤），
  // 取当前 provider 的首个可选模型。
  const composerPainting = useMemo<PaintingData>(() => {
    if (currentPainting.model) return currentPainting
    const fallback = modelCatalog.optionsByProvider.get(currentPainting.providerId)?.[0]?.value
    return fallback ? { ...currentPainting, model: String(fallback) } : currentPainting
  }, [currentPainting, modelCatalog.optionsByProvider])

  const {
    generating: liveGenerating,
    submitting,
    submit,
    cancel: cancelGeneration
  } = usePaintingGenerationSubmit({
    // fork 缝：V2 另传 `ensureCurrentCatalog`；fork hook 无异步目录参数（模型表同步可读）。
    painting: composerPainting,
    onPaintingChange: setCurrentPainting
  })

  // After a page switch the local `liveGenerating` boots false because
  // `usePaintingGeneration` reads from `painting.generationStatus` — the
  // painting record is a frozen receipt with no status. The cache fills the
  // gap: if its `status === 'running'` for this painting, keep the spinner.
  const generating = liveGenerating || liveGenerationState.generationStatus === 'running'
  const showTemplateShowcase =
    !currentPainting.persistedAt &&
    currentPainting.files.length === 0 &&
    !submitting &&
    !generating &&
    !currentPainting.generationStatus &&
    !liveGenerationState.generationStatus

  const switchModel = usePaintingModelSwitch({
    // fork 缝：V2 另传 `ensureProviderCatalog`；fork hook 无异步目录参数。
    painting: currentPainting,
    onPaintingChange: patchPainting
  })

  const list = usePaintingList({
    painting: currentPainting,
    setCurrentPainting,
    draftDefaults,
    historyItems: history.items,
    cancelGeneration,
    // fork 缝：fork usePaintingList 多一个必填 `reloadHistory`（V2 内部走 usePaintings.refresh）。
    reloadHistory: history.reload
  })

  const onCancel = useCallback(() => cancelGeneration(currentPainting.id), [cancelGeneration, currentPainting.id])
  const saveCurrentRef = useRef(list.saveCurrent)
  saveCurrentRef.current = list.saveCurrent

  useEffect(() => {
    return () => {
      void saveCurrentRef.current()
    }
  }, [])

  return (
    <div data-ui="paintings.view" className={paintingClasses.page}>
      {/* fork 缝：宿主需要标题栏/拖拽区——fork 的窗口没有 V2 的全局 tab 栏，页面自挂 Navbar。 */}
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('paintings.title')}</NavbarCenter>
      </Navbar>
      <div id="content-container" className={`${paintingClasses.content} min-h-0`}>
        <div className="flex h-full flex-1 flex-col">
          <div className={paintingClasses.frame}>
            <div className={paintingClasses.surface}>
              <PaintingStrip
                selectedPaintingId={currentPainting.id}
                runningPaintingId={generating ? currentPainting.id : undefined}
                items={history.items}
                hasMore={history.hasMore}
                loadMore={history.loadMore}
                onDeletePainting={list.remove}
                onSelectPainting={list.select}
                onAddPainting={list.add}
              />

              <div className={paintingClasses.centerPane}>
                <div className={paintingClasses.centerStage}>
                  {!showTemplateShowcase && <Artboard painting={composerPainting} isLoading={generating} />}
                </div>
                {showTemplateShowcase && (
                  <section
                    data-testid="painting-template-stage"
                    className="absolute inset-0 z-0 mx-auto flex min-h-0 w-full max-w-5xl items-center justify-center overflow-hidden px-3 pt-3 pb-36 [container-type:size]">
                    <div className="flex h-full max-h-80 min-h-0 w-full flex-col items-center">
                      <h1 className="max-w-xl shrink-0 text-center font-bold tracking-tight [font-size:clamp(var(--font-size-heading-sm),4cqw,var(--font-size-heading-md))] [line-height:1.1]">
                        {t('paintings.showcase.title')}
                      </h1>

                      <div className="mt-[clamp(8px,5cqh,30px)] flex min-h-0 w-full flex-1 flex-col items-center">
                        {promptPresets.length > 0 ? (
                          <PaintingTemplateShowcase
                            paintingId={composerPainting.id}
                            prompt={composerPainting.prompt}
                            templates={promptPresets}
                            onSelect={(prompt) => patchPainting({ prompt })}
                          />
                        ) : (
                          <Artboard painting={composerPainting} isLoading={false} />
                        )}

                        <p className="mt-[clamp(4px,2cqh,10px)] max-w-lg shrink-0 px-4 pb-1 text-center text-muted-foreground text-xs leading-5">
                          {t('paintings.showcase.caption')}
                        </p>
                      </div>
                    </div>
                  </section>
                )}
                <div className={paintingClasses.promptDock}>
                  <div className="mx-auto w-full max-w-5xl">
                    <QuickPanelProvider>
                      <PaintingComposer
                        painting={composerPainting}
                        generating={generating}
                        submitting={submitting}
                        onPromptChange={(prompt) => patchPainting({ prompt } as Partial<PaintingData>)}
                        onGenerate={submit}
                        onCancel={onCancel}
                        onModelSelect={switchModel}
                        onConfigChange={patchPainting}
                        onGenerateRandomSeed={(key) =>
                          patchPainting({
                            params: {
                              ...currentPainting.params,
                              [key]: String(Math.floor(Math.random() * 1_000_000))
                            }
                          })
                        }
                      />
                    </QuickPanelProvider>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PaintingPage
