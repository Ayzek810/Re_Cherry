/**
 * 画板（v0.3.3 批次4，② 薄适配）：zoom/rotate/drag 工具条 + awaiting|pending|ready
 * 状态机原样；ImageViewer → antd Image（preview 画廊，fork 既有 ImageViewer 组件
 * 即 antd Image 封装）。lucide-react 图标 fork 可用。
 */
import { loggerService } from '@logger'
import ImageViewer from '@renderer/components/ImageViewer'
import PaintingImageSkeleton from '@renderer/pages/paintings/components/PaintingImageSkeleton'
import { usePaintingSizeInfo } from '@renderer/pages/paintings/hooks/usePaintingSizeInfo'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { paintingClasses } from '@renderer/pages/paintings/paintingPrimitives'
import { computeImageNaturalSize } from '@renderer/pages/paintings/utils/computeImageNaturalSize'
import { getPaintingFileUrl } from '@renderer/pages/paintings/utils/paintingFileUrl'
import { resolveImageGenerationSupport } from '@shared/lightLlm/imageGenerationCatalog'
// fork 缝：原 `import { Button, Tooltip } from 'antd'` —— 工具栏按钮换回原生 button 后 Button 不再使用。
import { Tooltip } from 'antd'
import { ImageDown, ImageUp, Palette, RefreshCcw, RotateCcwSquare, RotateCwSquare, ZoomIn, ZoomOut } from 'lucide-react'
import {
  type FC,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('paintings/Artboard')

const DEFAULT_IMAGE_SCALE = 1
const MIN_IMAGE_SCALE = 0.25
const MAX_IMAGE_SCALE = 4
const IMAGE_SCALE_STEP = 0.25
const DEFAULT_IMAGE_OFFSET = { x: 0, y: 0 }
const PROMPT_POPOVER_CLOSE_DELAY = 150

type ImageOffset = typeof DEFAULT_IMAGE_OFFSET
type PromptPopoverOpenReason = 'keyboard' | 'pointer'

type ImageDragState = {
  pointerId: number
  x: number
  y: number
}

type RevealState =
  // Loading finished before any file exists (e.g. still generating on another
  // painting) — waiting for a file to arrive before starting the reveal.
  | { status: 'awaiting' }
  // A file exists; its natural size is still being decoded.
  | { status: 'pending'; fileId: string; imageUrl: string }
  // The natural size has resolved — enough to relock the box and drive the reveal.
  | { status: 'ready'; fileId: string; imageUrl: string; naturalWidth: number; naturalHeight: number }

export interface ArtboardProps {
  painting: PaintingData
  isLoading: boolean
  imageCover?: ReactNode
}

/**
 * Prompt + size strip. Rendered as a flex-col sibling directly above the
 * skeleton/image box (see call sites) so it stretches to match that box's
 * width rather than the full artboard.
 */
const ArtboardPromptBar: FC<{ prompt: string; sizeLabel?: string }> = ({ prompt, sizeLabel }) => {
  const { t } = useTranslation()
  const [isPromptPopoverOpen, setPromptPopoverOpen] = useState(false)
  const promptPopoverCloseTimerRef = useRef<number | null>(null)
  const promptPopoverTriggerRef = useRef<HTMLButtonElement | null>(null)
  const promptPopoverContentRef = useRef<HTMLDivElement | null>(null)
  const promptPopoverOpenReasonRef = useRef<PromptPopoverOpenReason>('pointer')

  const cancelPromptPopoverClose = useCallback(() => {
    if (promptPopoverCloseTimerRef.current === null) return
    window.clearTimeout(promptPopoverCloseTimerRef.current)
    promptPopoverCloseTimerRef.current = null
  }, [])

  const openPromptPopover = useCallback(
    (reason: PromptPopoverOpenReason) => {
      cancelPromptPopoverClose()
      promptPopoverOpenReasonRef.current = reason
      setPromptPopoverOpen(true)
    },
    [cancelPromptPopoverClose]
  )

  const openPromptPopoverFromPointer = useCallback(() => {
    cancelPromptPopoverClose()
    if (isPromptPopoverOpen) return
    promptPopoverOpenReasonRef.current = 'pointer'
    setPromptPopoverOpen(true)
  }, [cancelPromptPopoverClose, isPromptPopoverOpen])

  const schedulePromptPopoverClose = useCallback(() => {
    cancelPromptPopoverClose()
    promptPopoverCloseTimerRef.current = window.setTimeout(() => {
      promptPopoverCloseTimerRef.current = null
      const focusedElement = document.activeElement
      if (
        promptPopoverTriggerRef.current?.contains(focusedElement) ||
        promptPopoverContentRef.current?.contains(focusedElement)
      ) {
        return
      }
      setPromptPopoverOpen(false)
    }, PROMPT_POPOVER_CLOSE_DELAY)
  }, [cancelPromptPopoverClose])

  useEffect(() => cancelPromptPopoverClose, [cancelPromptPopoverClose])

  // fork 缝：A3 —— V2 把"按打开原因转移焦点"整段交给 Radix（`onOpenAutoFocus`/`onCloseAutoFocus`，
  // V2 `Artboard.tsx:160-166`）：只有键盘打开才把焦点送进面板，指针打开不抢焦点。fork 的面板是就地渲染的
  // div（非 portal），没有这套机制，`promptPopoverOpenReasonRef` 此前只写不读 → 键盘打开后焦点仍留在触发点上。
  useEffect(() => {
    if (!isPromptPopoverOpen || promptPopoverOpenReasonRef.current !== 'keyboard') return
    const content = promptPopoverContentRef.current
    if (!content) return
    // 焦点落在面板内第一个可聚焦元素（复制按钮）；没有可聚焦子节点时退到面板本身（tabIndex=-1）。
    const firstFocusable = content.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const target = firstFocusable ?? content
    target.focus()
  }, [isPromptPopoverOpen])

  // fork 缝：A3 —— 关闭后焦点回触发点（V2 `onCloseAutoFocus` 的默认行为）：键盘 Escape 关闭时
  // 焦点正在面板内，浏览器会把它丢给 body；触发点始终挂载，这里同步交还焦点。焦点已离开面板的关闭路径
  // （Tab 走后由 150ms 计时器关闭）不调用本函数，故不会把焦点从用户新落点抢回来。
  const closePromptPopoverAndRestoreFocus = useCallback(() => {
    cancelPromptPopoverClose()
    setPromptPopoverOpen(false)
    promptPopoverTriggerRef.current?.focus()
  }, [cancelPromptPopoverClose])

  return (
    <div className="mb-2 flex w-full min-w-0 items-center justify-between gap-2 text-muted-foreground text-xs">
      <div className="min-w-0 max-w-xs flex-1 overflow-hidden">
        {/* fork 缝：A3 —— V2 `PopoverContent` 上的这一整组处理器（V2 `Artboard.tsx:152-169`）在 fork 里全部丢失。
            指针进面板必须撤销"离开触发点即关闭"的计时器，否则鼠标移向面板时面板先关掉、面板里的复制按钮根本
            点不到；焦点进出面板同理（`onFocusCapture`/`onBlurCapture`，V2 逐字）。`onOpenAutoFocus`/
            `onCloseAutoFocus` 的焦点移交见本组件上方的 effect 与 `closePromptPopoverAndRestoreFocus`。 */}
        {isPromptPopoverOpen && (
          <div
            ref={promptPopoverContentRef}
            role="dialog"
            aria-label={t('common.prompt')}
            tabIndex={-1}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') openPromptPopoverFromPointer()
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'touch') schedulePromptPopoverClose()
            }}
            onFocusCapture={cancelPromptPopoverClose}
            onBlurCapture={schedulePromptPopoverClose}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              closePromptPopoverAndRestoreFocus()
            }}
            className="max-h-80 w-fit max-w-md overflow-y-auto rounded-md border-0 bg-neutral-900 p-2 text-neutral-50 text-xs leading-relaxed shadow-md">
            <button
              type="button"
              aria-label={t('common.copy')}
              // fork 缝：A3 —— 面板内唯一的可聚焦控件，也是键盘打开面板后的焦点落点；原来只有
              // `focus-visible:outline-none` + 极淡底色，焦点环缺失。补 ring 让"焦点已进面板"可见。
              className="float-right ml-0.5 flex size-5 items-center justify-center rounded-md text-neutral-50 hover:bg-neutral-50/10 focus-visible:bg-neutral-50/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                void navigator.clipboard.writeText(prompt)
                window.toast.success(t('message.copied'))
              }}>
              <Palette className="size-3.5" aria-hidden />
            </button>
            <span className="select-text whitespace-pre-wrap break-words">{prompt}</span>
          </div>
        )}
        <button
          ref={promptPopoverTriggerRef}
          type="button"
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') openPromptPopoverFromPointer()
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') schedulePromptPopoverClose()
          }}
          onBlur={schedulePromptPopoverClose}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            openPromptPopover('keyboard')
          }}
          className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-sm text-left text-inherit outline-none focus-visible:bg-accent focus-visible:text-foreground">
          <Palette className="size-3.5 shrink-0" aria-hidden />
          {/* CSS `truncate` clips to the available width responsively — the full
              prompt stays in the DOM (and in the popover) instead of a fixed-length
              JS slice that shows the same ~10 chars on a wide artboard. */}
          <span className="truncate">{prompt}</span>
        </button>
      </div>
      {sizeLabel && <span className="shrink-0">{sizeLabel}</span>}
    </div>
  )
}

const ArtboardToolButton: FC<{
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}> = ({ children, disabled, label, onClick }) => {
  // fork 缝：V2 的 Button（@cherrystudio/ui）渲染原生 button、只吃 className；antd Button 的 .ant-btn
  // 自带 height/padding/line-height（CSS-in-JS 注入晚于 Tailwind 层），会把 toolbarButton 的圆形工具
  // 按钮撑成 32px 高的胶囊。换回原生 button：className/aria-label/onClick/disabled 逐字保留（disabled
  // 用原生属性，语义等价）；Tooltip 保留 antd（rc-trigger 直接挂在子节点上，原生 button 同样可挂）。
  return (
    <Tooltip title={label} placement="right" mouseEnterDelay={0.8}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
        className={paintingClasses.toolbarButton}>
        {children}
      </button>
    </Tooltip>
  )
}

const Artboard: FC<ArtboardProps> = ({ painting, isLoading, imageCover }) => {
  const { t } = useTranslation()
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [imageScale, setImageScale] = useState(DEFAULT_IMAGE_SCALE)
  const [imageRotation, setImageRotation] = useState(0)
  const [imageOffset, setImageOffset] = useState<ImageOffset>(DEFAULT_IMAGE_OFFSET)
  const [isDraggingImage, setIsDraggingImage] = useState(false)
  const [revealState, setRevealState] = useState<RevealState | null>(null)
  const [viewerContainer, setViewerContainer] = useState<{ width: number; height: number } | null>(null)
  const [displayedNaturalSize, setDisplayedNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [promptBarHeight, setPromptBarHeight] = useState(0)
  const imageDragRef = useRef<ImageDragState | null>(null)
  const awaitingRevealRef = useRef(false)
  const previousLoadingRef = useRef(isLoading)
  const paintingIdRef = useRef(painting.id)
  const viewerResizeObserverRef = useRef<ResizeObserver | null>(null)
  const promptBarResizeObserverRef = useRef<ResizeObserver | null>(null)
  const displayedImageIndex = painting.files.length > 0 ? Math.min(currentImageIndex, painting.files.length - 1) : 0
  const currentFile = painting.files[displayedImageIndex]
  // 目录是同步静态数据（V2 此处是 useImageGenerationSupport 查询），无需 memo。
  const { sizeLabel } = usePaintingSizeInfo(
    painting,
    resolveImageGenerationSupport(painting.providerId, painting.model).support
  )
  const currentImageUrl = currentFile ? getPaintingFileUrl(currentFile) : undefined

  const onPrevImage = useCallback(() => {
    setCurrentImageIndex((index) => (index > 0 ? index - 1 : Math.max(0, painting.files.length - 1)))
  }, [painting.files.length])

  const onNextImage = useCallback(() => {
    setCurrentImageIndex((index) => (painting.files.length > 0 ? (index + 1) % painting.files.length : 0))
  }, [painting.files.length])

  const zoomIn = useCallback(() => {
    setImageScale((scale) => Math.min(MAX_IMAGE_SCALE, scale + IMAGE_SCALE_STEP))
  }, [])

  const zoomOut = useCallback(() => {
    setImageScale((scale) => Math.max(MIN_IMAGE_SCALE, scale - IMAGE_SCALE_STEP))
  }, [])

  const rotateImageRight = useCallback(() => {
    setImageRotation((rotation) => rotation + 90)
  }, [])

  const rotateImageLeft = useCallback(() => {
    setImageRotation((rotation) => rotation - 90)
  }, [])

  const resetImageTransform = useCallback(() => {
    imageDragRef.current = null
    setIsDraggingImage(false)
    setImageScale(DEFAULT_IMAGE_SCALE)
    setImageRotation(0)
    setImageOffset(DEFAULT_IMAGE_OFFSET)
  }, [])

  const onImagePointerDown = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    imageDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY
    }
    setIsDraggingImage(true)
  }, [])

  const onImagePointerMove = useCallback((event: PointerEvent<HTMLImageElement>) => {
    const dragState = imageDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    const deltaX = event.clientX - dragState.x
    const deltaY = event.clientY - dragState.y
    dragState.x = event.clientX
    dragState.y = event.clientY
    setImageOffset((offset) => ({ x: offset.x + deltaX, y: offset.y + deltaY }))
  }, [])

  const stopImageDrag = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (imageDragRef.current?.pointerId === event.pointerId) {
      imageDragRef.current = null
      setIsDraggingImage(false)
    }
  }, [])

  // Explicit contain-fit box for the idle (already-generated) image, mirroring
  // PaintingImageSkeleton's lockedSize math. CSS auto-sizing a flex-col wrapper around
  // the image can't be trusted here — the antd Image wrapper nests the `<img>` behind
  // a context-menu wrapper that breaks intrinsic-size propagation, leaving the
  // wrapper (and the prompt bar stretched to it) wider than the rendered photo.
  // Measuring explicitly is what lets the prompt bar match the image's real edges.
  //
  // fork 缝（v0.3.3-9）：V2 用 `<img onLoad>` 取自然尺寸（V2 的 ImageViewer 是**裸 `<img>`**，
  // className/style/onLoad 都直接落在 img 上）。fork 的 ImageViewer 建在 antd Image 上，而
  // rc-image 只把 `COMMON_PROPS`（crossOrigin/decoding/draggable/loading/referrerPolicy/
  // sizes/srcSet/useMap/alt）交给 `<img>`，其余 props 落在**外层 div** 上——`onLoad` 永远不触发，
  // 于是 `displayedNaturalSize` 恒为 null、显式 contain 盒失效，图片按 antd 默认
  // `width:100%` 撑开后被容器 `overflow-hidden` **裁掉**（用户看到的"裁剪填满"）。
  // 故改用与本页 reveal 路径同一个"按 URL 量尺寸"的助手，不依赖 img 元素的事件。
  useEffect(() => {
    if (!currentImageUrl) {
      setDisplayedNaturalSize(null)
      return
    }
    let active = true
    void computeImageNaturalSize(currentImageUrl)
      .then((result) => {
        if (!active) return
        setDisplayedNaturalSize(result ? { width: result.naturalWidth, height: result.naturalHeight } : null)
      })
      .catch((error) => {
        logger.warn('Failed to measure displayed painting image', { error })
        if (active) setDisplayedNaturalSize(null)
      })
    return () => {
      active = false
    }
  }, [currentImageUrl])

  // A plain ref + mount-only effect would only ever attach once, when Artboard
  // itself first mounts — but this wrapper only exists in the DOM once the idle
  // (already-generated) branch renders, which usually happens later (after a
  // generation completes) than Artboard's own mount. A callback ref re-attaches
  // the observer every time the branch swaps this node in, not just the first time.
  const setViewerContainerRef = useCallback((el: HTMLDivElement | null) => {
    viewerResizeObserverRef.current?.disconnect()
    viewerResizeObserverRef.current = null
    if (!el) return
    const measure = () => setViewerContainer({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    viewerResizeObserverRef.current = observer
  }, [])

  // `promptBar` renders in the fixed layout wrapper above the transformed image,
  // so its own rendered height has to come out of the space
  // `displayedImageBoxSize` treats as available — otherwise bar + image
  // together can exceed `viewerContainer` and the image gets clipped instead
  // of contain-fitting alongside the bar.
  const setPromptBarRef = useCallback((el: HTMLDivElement | null) => {
    promptBarResizeObserverRef.current?.disconnect()
    promptBarResizeObserverRef.current = null
    if (!el) {
      setPromptBarHeight(0)
      return
    }
    const measure = () => setPromptBarHeight(el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    promptBarResizeObserverRef.current = observer
  }, [])

  useEffect(() => {
    setDisplayedNaturalSize(null)
  }, [currentFile?.id])

  const displayedImageBoxSize = (() => {
    if (!displayedNaturalSize || !viewerContainer || viewerContainer.width <= 0) {
      return null
    }
    const availableHeight = Math.max(0, viewerContainer.height - promptBarHeight)
    if (availableHeight <= 0) {
      return null
    }
    const scale = Math.min(
      1,
      viewerContainer.width / displayedNaturalSize.width,
      availableHeight / displayedNaturalSize.height
    )
    return { width: displayedNaturalSize.width * scale, height: displayedNaturalSize.height * scale }
  })()

  useEffect(() => {
    setCurrentImageIndex(0)
    resetImageTransform()
  }, [painting.id, resetImageTransform])

  useLayoutEffect(() => {
    resetImageTransform()
  }, [currentFile?.id, resetImageTransform])

  useLayoutEffect(() => {
    // A new painting starts with a clean reveal machine. `revealState` and the
    // loading/awaiting refs live across painting switches (Artboard is not
    // remounted per painting), so without this reset the previous painting's
    // in-flight reveal leaks in — stranding a file-less painting in a permanent
    // fake "generating" skeleton, or replaying a reveal over an already-generated
    // one. `wasLoading` is forced to this painting's own `isLoading` on a switch
    // so a not-loading new painting never inherits the previous one's loading.
    const paintingChanged = paintingIdRef.current !== painting.id
    paintingIdRef.current = painting.id
    if (paintingChanged) {
      awaitingRevealRef.current = false
      setRevealState(null)
    }

    const wasLoading = paintingChanged ? isLoading : previousLoadingRef.current
    previousLoadingRef.current = isLoading

    if (isLoading) {
      awaitingRevealRef.current = false
      setRevealState(null)
      return
    }

    const shouldStartReveal = wasLoading || awaitingRevealRef.current

    if (!shouldStartReveal) {
      setRevealState((state) =>
        state && state.status !== 'awaiting' && (state.fileId !== currentFile?.id || state.imageUrl !== currentImageUrl)
          ? null
          : state
      )
      return
    }

    if (!currentFile || !currentImageUrl) {
      // A canceled or failed generation never produces a file — without this,
      // stopping here would leave `revealState` stuck at `{ status: 'awaiting' }`
      // forever, since none of this effect's deps change again to escape it.
      if (painting.generationStatus === 'canceled' || painting.generationStatus === 'failed') {
        awaitingRevealRef.current = false
        setRevealState(null)
        return
      }
      awaitingRevealRef.current = true
      setRevealState((state) => (state?.status === 'awaiting' ? state : { status: 'awaiting' }))
      return
    }

    let active = true
    const target = { fileId: currentFile.id, imageUrl: currentImageUrl }
    awaitingRevealRef.current = false
    setRevealState({ ...target, status: 'pending' })

    void computeImageNaturalSize(currentImageUrl)
      .then((result) => {
        if (!active) {
          return
        }

        if (!result) {
          setRevealState(null)
          return
        }

        setRevealState({
          ...target,
          naturalWidth: result.naturalWidth,
          naturalHeight: result.naturalHeight,
          status: 'ready'
        })
      })
      .catch((error) => {
        logger.warn('Failed to prepare painting image reveal', { error })
        if (active) {
          setRevealState(null)
        }
      })

    return () => {
      active = false
    }
  }, [painting.id, currentFile, currentImageUrl, isLoading, painting.generationStatus])

  const activeReveal = (() => {
    if (isLoading || !revealState) {
      return null
    }
    if (revealState.status === 'awaiting') {
      return revealState
    }
    return currentFile?.id === revealState.fileId && currentImageUrl === revealState.imageUrl ? revealState : null
  })()

  const finishReveal = useCallback(() => {
    setRevealState(null)
  }, [])

  const promptBar = painting.prompt ? <ArtboardPromptBar prompt={painting.prompt} sizeLabel={sizeLabel} /> : undefined

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col p-2">
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center [container-type:size]">
        {isLoading || activeReveal ? (
          <PaintingImageSkeleton
            imageUrl={activeReveal?.status === 'ready' ? activeReveal.imageUrl : undefined}
            naturalWidth={activeReveal?.status === 'ready' ? activeReveal.naturalWidth : undefined}
            naturalHeight={activeReveal?.status === 'ready' ? activeReveal.naturalHeight : undefined}
            onRevealReady={activeReveal?.status === 'ready' ? finishReveal : undefined}
            painting={painting}
            topBar={promptBar}
          />
        ) : painting.files.length > 0 && currentImageUrl ? (
          <div
            ref={setViewerContainerRef}
            className="relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
            {/* The prompt bar is a flex-col sibling of the transformed image so it stays
                fixed while the image pans, zooms, or rotates. The layout wrapper is
                sized explicitly (displayedImageBoxSize, which already
                reserves the bar's own measured height — see setPromptBarRef) rather than
                via CSS auto-sizing — the antd Image wrapper nests the `<img>` behind a
                context-menu wrapper that breaks intrinsic-size propagation, so an
                auto-sized flex-col here ends up wider than the rendered photo,
                letterboxing the bar past its real edges. */}
            <div
              data-testid="artboard-image-layout"
              className="flex max-h-full max-w-full flex-col items-stretch"
              style={{
                ...(displayedImageBoxSize ? { width: displayedImageBoxSize.width } : undefined)
              }}>
              {promptBar && (
                <div ref={setPromptBarRef} data-testid="artboard-prompt-bar-measure">
                  {promptBar}
                </div>
              )}
              <ImageViewer
                alt=""
                data-testid="artboard-image-transform"
                className={`max-h-full min-h-0 max-w-full select-none rounded-md object-contain ${
                  isDraggingImage
                    ? 'cursor-grabbing transition-none will-change-transform'
                    : 'cursor-grab transition-transform duration-150'
                }`}
                draggable={false}
                onPointerCancel={stopImageDrag}
                onPointerDown={onImagePointerDown}
                onPointerMove={onImagePointerMove}
                onPointerUp={stopImageDrag}
                preview={false}
                src={currentImageUrl}
                style={{
                  touchAction: 'none',
                  transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageScale}) rotate(${imageRotation}deg)`,
                  ...(displayedImageBoxSize ? { height: displayedImageBoxSize.height } : undefined)
                }}
              />
            </div>
            <div
              className={`${paintingClasses.toolbarWrap} ${paintingClasses.toolbarRail}`}
              role="toolbar"
              aria-label={t('preview.label')}>
              {painting.files.length > 1 && (
                <>
                  <ArtboardToolButton label={t('preview.previous')} onClick={onPrevImage}>
                    <ImageUp className="size-[18px]" />
                  </ArtboardToolButton>
                  <ArtboardToolButton label={t('preview.next')} onClick={onNextImage}>
                    <ImageDown className="size-[18px]" />
                  </ArtboardToolButton>
                  <span className="my-0.5 h-px w-4 bg-border-subtle" aria-hidden />
                </>
              )}
              <ArtboardToolButton
                label={t('preview.zoom_out')}
                disabled={imageScale <= MIN_IMAGE_SCALE}
                onClick={zoomOut}>
                <ZoomOut className="size-4" />
              </ArtboardToolButton>
              <ArtboardToolButton
                label={t('preview.zoom_in')}
                disabled={imageScale >= MAX_IMAGE_SCALE}
                onClick={zoomIn}>
                <ZoomIn className="size-4" />
              </ArtboardToolButton>
              <ArtboardToolButton label={t('preview.rotate_left')} onClick={rotateImageLeft}>
                <RotateCcwSquare className="size-4" />
              </ArtboardToolButton>
              <ArtboardToolButton label={t('preview.rotate_right')} onClick={rotateImageRight}>
                <RotateCwSquare className="size-4" />
              </ArtboardToolButton>
              <ArtboardToolButton label={t('preview.reset')} onClick={resetImageTransform}>
                <RefreshCcw className="size-4" />
              </ArtboardToolButton>
            </div>
            <div className="-translate-x-1/2 absolute bottom-2.5 left-1/2 rounded-full bg-foreground/60 px-2 py-1 text-background text-xs">
              {displayedImageIndex + 1} / {painting.files.length}
            </div>
          </div>
        ) : imageCover ? (
          imageCover
        ) : (
          <div
            role="img"
            aria-label={t('paintings.image_placeholder')}
            className="relative size-[min(72cqh,96cqw)] rounded-3xl border border-border-subtle bg-[linear-gradient(145deg,var(--muted),transparent_58%)]">
            <div
              aria-hidden
              className="absolute inset-2 rounded-2xl border border-border-subtle bg-background-subtle"
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default Artboard
