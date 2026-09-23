/**
 * 绘画页（v0.3.3-2，骨架改回 V2 PaintingPage 原样形态）：
 * `page > content > frame > surface`（V2 paintingPrimitives class 常量）
 * = 左侧 68px 竖向历史条（PaintingStrip）+ 中央列（centerStage 舞台 / 模板空态 section /
 * promptDock 底部提示条）。参数不再是页面级抽屉——V2 里它挂在提示条内的 Popover（见
 * PaintingComposer）。数据面仍是 fork 既有五 hooks + PaintingSessionContext。
 */
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import Artboard from '@renderer/pages/paintings/components/Artboard'
import PaintingComposer from '@renderer/pages/paintings/components/PaintingComposer'
import type { PaintingModelSelection } from '@renderer/pages/paintings/components/PaintingModelSelector'
import PaintingStrip from '@renderer/pages/paintings/components/PaintingStrip'
import PaintingTemplateShowcase from '@renderer/pages/paintings/components/PaintingTemplateShowcase'
import { PaintingSessionProvider, usePaintingSession } from '@renderer/pages/paintings/context/PaintingSessionContext'
import {
  type MaterializeInputs,
  usePaintingGenerationSubmit
} from '@renderer/pages/paintings/hooks/usePaintingGenerationSubmit'
import { usePaintingHistory } from '@renderer/pages/paintings/hooks/usePaintingHistory'
import { usePaintingInitialDraft } from '@renderer/pages/paintings/hooks/usePaintingInitialDraft'
import { usePaintingList } from '@renderer/pages/paintings/hooks/usePaintingList'
import { usePaintingModelSwitch } from '@renderer/pages/paintings/hooks/usePaintingModelSwitch'
import { usePaintingProviderOptions } from '@renderer/pages/paintings/hooks/usePaintingProviderOptions'
import { usePaintingResultSync } from '@renderer/pages/paintings/hooks/usePaintingResultSync'
import { usePaintingTemplateCatalog } from '@renderer/pages/paintings/hooks/usePaintingTemplateCatalog'
import { createDefaultPainting, type PaintingDraftDefaults } from '@renderer/pages/paintings/model/paintingPipeline'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { paintingClasses } from '@renderer/pages/paintings/paintingPrimitives'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setPaintingModel } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { type FC, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const PaintingsPage: FC = () => {
  const providerOptions = usePaintingProviderOptions()
  const history = usePaintingHistory()
  const defaultProviderId = providerOptions[0]?.value ?? ''

  return (
    <PaintingSessionProvider initialPainting={createDefaultPainting({ providerId: defaultProviderId })}>
      <PaintingsPageInner
        historyItems={history.items}
        hasMore={history.hasMore}
        loadMore={history.loadMore}
        reloadHistory={history.reload}
      />
    </PaintingSessionProvider>
  )
}

interface InnerProps {
  historyItems: PaintingData[]
  hasMore: boolean
  loadMore: () => void
  reloadHistory: () => void
}

const PaintingsPageInner: FC<InnerProps> = ({ historyItems, hasMore, loadMore, reloadHistory }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const paintingModel = useAppSelector((state) => state.llm.paintingModel)
  const { currentPainting, setCurrentPainting, patchPainting, tray, generationStateById } = usePaintingSession()

  const draftDefaults = useMemo<PaintingDraftDefaults>(
    () => ({ providerId: currentPainting.providerId }),
    [currentPainting.providerId]
  )

  const { generating, submitting, submit, cancel } = usePaintingGenerationSubmit({
    painting: currentPainting,
    onPaintingChange: setCurrentPainting
  })
  const list = usePaintingList({
    painting: currentPainting,
    setCurrentPainting,
    draftDefaults,
    historyItems,
    cancelGeneration: cancel,
    reloadHistory
  })
  const switchModel = usePaintingModelSwitch({ painting: currentPainting, onPaintingChange: patchPainting })
  usePaintingInitialDraft({ currentPainting, draftDefaults, setCurrentPainting })
  usePaintingResultSync({ currentPainting, historyItems, setCurrentPainting })
  const { templates } = usePaintingTemplateCatalog()

  const handleModelSelect = useCallback(
    (selection: PaintingModelSelection) => {
      // 批次5 双门镜像：llm.paintingModel 供聊天生图门（assistant.enableGenerateImage
      // && paintingModel）与提示条回显；表单态走 switchModel（params 重置 + 托盘清）。
      const model: Model = {
        id: selection.modelId,
        provider: selection.providerId,
        name: selection.modelId,
        group: ''
      }
      dispatch(setPaintingModel({ model }))
      void switchModel(selection)
    },
    [dispatch, switchModel]
  )

  const handleGenerate = useCallback((materialize: MaterializeInputs) => void submit(materialize), [submit])

  const handleRandomSeed = useCallback(
    (key: string) => {
      patchPainting({
        params: { ...(currentPainting.params ?? {}), [key]: String(Math.floor(Math.random() * 1_000_000)) }
      } as Partial<PaintingData>)
    },
    [currentPainting.params, patchPainting]
  )

  /** 缩略条在途标记：会话镜像里唯一 running 态的 id（提交串行，实际至多一个）。 */
  const runningPaintingId = useMemo(() => {
    for (const [id, state] of generationStateById) {
      if (state?.generationStatus === 'running') return id
    }
    return undefined
  }, [generationStateById])

  // V2 PaintingPage:85-91 原样条件：未落盘 + 无产物 + 非提交/生成中 + 无在途生成态。
  const liveGenerationState = generationStateById.get(currentPainting.id)
  const showTemplateShowcase =
    !currentPainting.persistedAt &&
    currentPainting.files.length === 0 &&
    !submitting &&
    !generating &&
    !currentPainting.generationStatus &&
    !liveGenerationState?.generationStatus

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('paintings.title')}</NavbarCenter>
      </Navbar>
      <div data-ui="paintings.view" className={paintingClasses.page}>
        <div id="content-container" className={paintingClasses.content}>
          <div className="flex h-full flex-1 flex-col">
            <div className={paintingClasses.frame}>
              <div className={paintingClasses.surface}>
                <PaintingStrip
                  selectedPaintingId={currentPainting.id}
                  runningPaintingId={runningPaintingId}
                  items={historyItems}
                  hasMore={hasMore}
                  loadMore={loadMore}
                  onDeletePainting={list.remove}
                  onSelectPainting={list.select}
                  onAddPainting={list.add}
                />

                <div className={paintingClasses.centerPane}>
                  <div className={paintingClasses.centerStage}>
                    {!showTemplateShowcase && <Artboard painting={currentPainting} isLoading={generating} />}
                  </div>
                  {showTemplateShowcase && (
                    <section
                      data-testid="painting-template-stage"
                      className="absolute inset-0 z-0 mx-auto flex min-h-0 w-full max-w-5xl items-center justify-center overflow-hidden px-3 pt-3 pb-36 [container-type:size]">
                      <div className="flex h-full max-h-80 min-h-0 w-full flex-col items-center">
                        <h1 className="max-w-xl shrink-0 text-center font-bold tracking-tight [line-height:1.1]">
                          {t('paintings.showcase.title')}
                        </h1>

                        <div className="mt-[clamp(8px,5cqh,30px)] flex min-h-0 w-full flex-1 flex-col items-center">
                          {templates.length > 0 ? (
                            <PaintingTemplateShowcase
                              paintingId={currentPainting.id}
                              prompt={currentPainting.prompt}
                              templates={templates}
                              onSelect={(prompt) => patchPainting({ prompt })}
                            />
                          ) : (
                            <Artboard painting={currentPainting} isLoading={false} />
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
                          painting={currentPainting}
                          generating={generating}
                          submitting={submitting}
                          model={paintingModel}
                          onPromptChange={(prompt) => patchPainting({ prompt })}
                          onGenerate={handleGenerate}
                          onCancel={() => cancel(currentPainting.id)}
                          onModelSelect={handleModelSelect}
                          onConfigChange={patchPainting}
                          onGenerateRandomSeed={handleRandomSeed}
                          tray={tray}
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
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
`

export default PaintingsPage
