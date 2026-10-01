/**
 * 历史缩略条（v0.3.3 批次4，② 薄适配）：缩略图/删除交互原样；数据源 → 传 props
 * （页面从 Dexie 读，组件内不直接碰 db）。ConfirmDialog → antd Modal.confirm 形态
 * （受控 Modal）。paintingClasses 从 ① paintingPrimitives import。
 */
import PaintingSkeletonSurface from '@renderer/pages/paintings/components/PaintingSkeletonSurface'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { paintingClasses } from '@renderer/pages/paintings/paintingPrimitives'
import { getPaintingFileUrl } from '@renderer/pages/paintings/utils/paintingFileUrl'
// fork 缝：原 `import { Button, Modal } from 'antd'` —— historyAddButton 换回原生 button 后 Button 不再使用；
// Tooltip 补回 A1（V2 把新建按钮包在 Tooltip 里，见下方注释）。
import { Modal, Tooltip } from 'antd'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import type { FC, UIEventHandler } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface PaintingStripProps {
  selectedPaintingId?: string
  /** Id of the painting with an in-flight generation, or undefined when idle. */
  runningPaintingId?: string
  items: PaintingData[]
  isLoading: boolean
  hasMore: boolean
  /** 历史读取失败原因（null = 没有失败）。见 usePaintingHistory 的失败语义。 */
  error: Error | null
  loadMore: () => void
  /** 清错重跑首页（错误态里的"重试"）。 */
  retry: () => void
  onDeletePainting: (painting: PaintingData) => void
  onSelectPainting: (painting: PaintingData) => void
  onAddPainting: () => void
}

const PaintingStripItem: FC<{
  painting: PaintingData
  selected: boolean
  loading: boolean
  onDelete: (painting: PaintingData) => void
  onSelect: (painting: PaintingData) => void
  selectLabel: string
  deleteLabel: string
}> = ({ painting, selected, loading, onDelete, onSelect, selectLabel, deleteLabel }) => {
  const previewFile = painting.files?.[0]
  const previewUrl = previewFile ? getPaintingFileUrl(previewFile) : undefined

  return (
    <div className={`${paintingClasses.historyItem} ${selected ? paintingClasses.historyItemActive : ''}`}>
      <button
        type="button"
        className="absolute inset-0 z-0"
        aria-label={selectLabel}
        onClick={() => onSelect(painting)}>
        <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[12px]">
          {previewUrl ? (
            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
          ) : loading ? (
            <div className="size-full bg-background">
              <PaintingSkeletonSurface />
            </div>
          ) : (
            <span className="block size-full bg-muted/60" aria-hidden />
          )}
        </span>
      </button>

      {selected && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 rounded-[12px] ring-1 ring-muted-foreground/55 ring-inset"
        />
      )}

      {loading && previewFile && (
        <span className="pointer-events-none absolute inset-x-1 bottom-1 z-10 h-1 overflow-hidden rounded-full bg-black/10">
          <span className="block h-full w-5 animate-[painting-history-loading_1.2s_ease-in-out_infinite] rounded-full bg-foreground/70" />
        </span>
      )}

      <button
        type="button"
        aria-label={deleteLabel}
        // fork 缝：A2 —— V2 `historyDelete` 只有 `group-hover:opacity-100`（PaintingStrip 自身也漏了键盘态），
        // 于是 Tab 到删除按钮时它是 opacity-0：聚焦了却看不见，也没有焦点环（WCAG 2.4.7）。
        // 就地追加 V2 在别处（V2 `PaintingImageGallery.tsx:120`）用的同一写法：`group-focus-within:opacity-100`
        // 与 hover 并列为显形条件；再补 `focus-visible:ring-*` 让键盘焦点可见。paintingClasses 常量表不动。
        className={`${paintingClasses.historyDelete} focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-focus-within:opacity-100`}
        onClick={(event) => {
          event.stopPropagation()
          onDelete(painting)
        }}>
        <Trash2 className="size-3" />
      </button>
    </div>
  )
}

const PaintingStrip: FC<PaintingStripProps> = ({
  selectedPaintingId,
  runningPaintingId,
  items,
  isLoading,
  hasMore,
  error,
  loadMore,
  retry,
  onDeletePainting,
  onSelectPainting,
  onAddPainting
}) => {
  const { t } = useTranslation()
  const [pendingDelete, setPendingDelete] = useState<PaintingData | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const handleScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const target = event.currentTarget
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 120) {
      loadMore()
    }
  }

  useEffect(() => {
    const strip = stripRef.current
    // 错误态不分页补页：失败时 hasMore 已置 false，这里再显式短路，避免错误态被反复重试。
    if (error) return
    if (hasMore && strip && strip.scrollHeight <= strip.clientHeight) {
      loadMore()
    }
  }, [error, hasMore, items.length, loadMore])

  return (
    <>
      <div ref={stripRef} className={paintingClasses.historyStrip} onScroll={handleScroll}>
        {/* fork 缝：V2 的 Button（@cherrystudio/ui）渲染原生 button、只吃 className；antd Button 的
            .ant-btn 自带 height/padding，会顶掉 paintingClasses.historyAddButton 的 h-11 w-11（44px）。
            换回原生 button：className/aria-label/onClick 逐字保留；antd 专有的 `icon` prop 无原生对应物，
            等价展开为子节点（antd 内部同样渲染 <span class="ant-btn-icon">{icon}</span>）。 */}
        {/* fork 缝：A1 —— V2 `PaintingStrip.tsx:115-125` 把新建按钮包在
            `<Tooltip content={t('paintings.button.new.image')} placement="right" delay={500}>` 里；fork 只剩裸
            `<button aria-label=…>`，鼠标操作者永远看不到"新建"提示。antd Tooltip 对应 content→title、
            delay(ms)→mouseEnterDelay(s)，键沿用 V2 同键 `paintings.button.new.image`。Tooltip 只 clone 子节点、
           不产生包裹元素，故 historyAddButton 的 `sticky top-0` 布局不变。 */}
        <Tooltip title={t('paintings.button.new.image')} placement="right" mouseEnterDelay={0.5}>
          <button
            type="button"
            className={paintingClasses.historyAddButton}
            aria-label={t('paintings.button.new.image')}
            onClick={onAddPainting}>
            <Plus className="size-4" />
          </button>
        </Tooltip>
        {items.map((painting) => (
          <PaintingStripItem
            key={painting.id}
            painting={painting}
            selected={painting.id === selectedPaintingId}
            loading={painting.id === runningPaintingId}
            onDelete={setPendingDelete}
            onSelect={onSelectPainting}
            selectLabel={t('paintings.button.select.image')}
            deleteLabel={t('paintings.button.delete.image.label')}
          />
        ))}
        {/* 三态（二轮审查 f2-15）：失败不得与"没有历史"同形，也不得让 hasMore 停在 true 转圈。 */}
        {error ? (
          <div
            data-testid="painting-history-error"
            className="flex w-full shrink-0 flex-col items-center gap-1 px-1 py-2 text-center">
            <span className="text-[10px] text-destructive leading-4">{t('paintings.history_load_failed')}</span>
            <button
              type="button"
              className="rounded-md border border-border-subtle px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary-hover hover:text-foreground"
              onClick={retry}>
              {t('common.retry')}
            </button>
          </div>
        ) : isLoading && items.length === 0 ? (
          // 首帧骨架（§9 Rendering：每个状态都要有骨架或占位）。只画纯色占位，不启用
          // PaintingSkeletonSurface 的逐格动画——缩略条里放三份 ResizeObserver + 动画循环不值当。
          <div className="flex w-full shrink-0 flex-col gap-2" data-testid="painting-history-skeleton">
            {Array.from({ length: 3 }).map((_, index) => (
              <span
                key={index}
                aria-hidden
                className={`${paintingClasses.historyItem} animate-pulse overflow-hidden bg-muted/60`}
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <span className="px-1 py-2 text-center text-[10px] text-foreground-tertiary leading-4">
            {t('paintings.history_empty')}
          </span>
        ) : null}
        {hasMore && !error && (
          <Loader2 className="mx-auto size-4 shrink-0 animate-spin text-foreground-tertiary" aria-hidden />
        )}
      </div>

      <style>{`
        @keyframes painting-history-loading {
          0% { transform: translateX(-150%); }
          100% { transform: translateX(260%); }
        }
      `}</style>

      <Modal
        open={Boolean(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
        title={t('paintings.button.delete.image.confirm')}
        okText={t('common.delete')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true }}
        centered
        onOk={() => {
          if (pendingDelete) {
            onDeletePainting(pendingDelete)
          }
          setPendingDelete(null)
        }}
      />
    </>
  )
}

export default PaintingStrip
