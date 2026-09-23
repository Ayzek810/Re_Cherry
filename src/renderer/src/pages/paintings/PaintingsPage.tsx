/**
 * 绘画页（v0.3.3 批次4，页面壳 fork 新写 + ② hooks 接线完成）：
 * 布局 = 左侧历史/模板栏（PaintingStrip + PaintingTemplateShowcase）+ 中部
 * Artboard + 底部 PaintingComposer + PaintingImageGallery + PaintingSettings
 * 抽屉；挂 PaintingSessionContext Provider。风格对齐 KnowledgePage/TranslatePage
 * 的 Container/Navbar 模式。AI 通路 = paintingImageService（② hooks 消化：
 * usePaintingGenerationSubmit 编排 validate→materialize→generate；删除/切换
 * 走 usePaintingList 级联清仓；模型切换走 usePaintingModelSwitch 并镜像
 * dispatch setPaintingModel（批次5 聊天生图双门的模型面）。
 */
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import Scrollbar from '@renderer/components/Scrollbar'
import Artboard from '@renderer/pages/paintings/components/Artboard'
import PaintingComposer from '@renderer/pages/paintings/components/PaintingComposer'
import PaintingImageGallery from '@renderer/pages/paintings/components/PaintingImageGallery'
import type { PaintingModelSelection } from '@renderer/pages/paintings/components/PaintingModelSelector'
import PaintingSettings from '@renderer/pages/paintings/components/PaintingSettings'
import PaintingStrip from '@renderer/pages/paintings/components/PaintingStrip'
import PaintingTemplateShowcase from '@renderer/pages/paintings/components/PaintingTemplateShowcase'
import { usePaintingSession, PaintingSessionProvider } from '@renderer/pages/paintings/context/PaintingSessionContext'
import { usePaintingHistory } from '@renderer/pages/paintings/hooks/usePaintingHistory'
import { usePaintingInitialDraft } from '@renderer/pages/paintings/hooks/usePaintingInitialDraft'
import { usePaintingList } from '@renderer/pages/paintings/hooks/usePaintingList'
import { usePaintingGenerationSubmit, type MaterializeInputs } from '@renderer/pages/paintings/hooks/usePaintingGenerationSubmit'
import { usePaintingModelSwitch } from '@renderer/pages/paintings/hooks/usePaintingModelSwitch'
import { usePaintingProviderOptions } from '@renderer/pages/paintings/hooks/usePaintingProviderOptions'
import { usePaintingResultSync } from '@renderer/pages/paintings/hooks/usePaintingResultSync'
import { usePaintingTemplateCatalog } from '@renderer/pages/paintings/hooks/usePaintingTemplateCatalog'
import { createDefaultPainting, type PaintingDraftDefaults } from '@renderer/pages/paintings/model/paintingPipeline'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setPaintingModel } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { Button, Drawer } from 'antd'
import { Plus } from 'lucide-react'
import { type FC, useCallback, useMemo, useState } from 'react'
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
  const [settingsOpen, setSettingsOpen] = useState(false)

  // 新草稿种子跟随当前 provider（V2 默认偏好未移植，见 usePaintingInitialDraft 头注）。
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
      // && paintingModel）与 Composer 回显；表单态走 switchModel（params 重置 + 托盘清）。
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
        params: { ...(currentPainting.params ?? {}), [key]: String(Math.floor(Math.random() * 2147483647)) }
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

  const showTemplateShowcase = useMemo(
    () => !currentPainting.persistedAt && currentPainting.files.length === 0,
    [currentPainting.persistedAt, currentPainting.files.length]
  )

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('paintings.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <SideNav>
          <SideHeader>
            <span>{t('paintings.history')}</span>
            <Button
              type="text"
              size="small"
              icon={<Plus size={16} />}
              onClick={list.add}
              aria-label={t('paintings.button.new.image')}
            />
          </SideHeader>
          <PaintingStrip
            selectedPaintingId={currentPainting.id}
            runningPaintingId={runningPaintingId}
            items={historyItems}
            hasMore={hasMore}
            loadMore={loadMore}
            onDeletePainting={(painting) => void list.remove(painting)}
            onSelectPainting={(painting) => void list.select(painting)}
            onAddPainting={list.add}
          />
        </SideNav>
        <MainContent>
          <CenterStage>
            {showTemplateShowcase ? (
              <ShowcaseWrap>
                <ShowcaseTitle>{t('paintings.showcase.title')}</ShowcaseTitle>
                <PaintingTemplateShowcase
                  paintingId={currentPainting.id}
                  prompt={currentPainting.prompt}
                  templates={templates}
                  onSelect={(prompt) => patchPainting({ prompt })}
                />
                <ShowcaseCaption>{t('paintings.showcase.caption')}</ShowcaseCaption>
              </ShowcaseWrap>
            ) : (
              <Artboard painting={currentPainting} isLoading={generating} />
            )}
          </CenterStage>
          <ResultTray>
            <PaintingImageGallery files={currentPainting.files} />
          </ResultTray>
          <PromptDock>
            <PaintingComposer
              painting={currentPainting}
              generating={generating}
              submitting={submitting}
              model={paintingModel}
              onPromptChange={(prompt) => patchPainting({ prompt })}
              onGenerate={handleGenerate}
              onCancel={() => cancel(currentPainting.id)}
              onModelSelect={handleModelSelect}
              onOpenSettings={() => setSettingsOpen(true)}
              tray={tray}
            />
          </PromptDock>
        </MainContent>
      </ContentContainer>
      <Drawer
        title={t('paintings.settings')}
        placement="right"
        width={320}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        destroyOnClose>
        <PaintingSettings
          painting={currentPainting}
          onConfigChange={patchPainting}
          onGenerateRandomSeed={handleRandomSeed}
        />
      </Drawer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height));
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 100%;
`

const SideNav = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  width: calc(var(--settings-width) + 60px);
  border-right: 0.5px solid var(--color-border);
  padding: 12px 10px;
`

const SideHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 8px;
  font-size: 13px;
  color: var(--color-text-2);
`

const MainContent = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
`

const CenterStage = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: center;
  justify-content: center;
  padding: 12px;
`

const ShowcaseWrap = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 720px;
`

const ShowcaseTitle = styled.h1`
  margin: 0;
  font-size: 20px;
  text-align: center;
`

const ShowcaseCaption = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-3);
  text-align: center;
`

const ResultTray = styled.div`
  flex-shrink: 0;
  max-height: 120px;
  overflow: hidden;
  padding: 0 12px;
`

const PromptDock = styled.div`
  flex-shrink: 0;
  padding: 8px 12px 12px;
`

export default PaintingsPage
