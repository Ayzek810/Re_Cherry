/**
 * 历史缩略条（v0.3.3 批次4，② 薄适配）：缩略图/删除交互原样；数据源 → 传 props
 * （页面从 Dexie 读，组件内不直接碰 db）。ConfirmDialog → antd Modal.confirm 形态
 * （受控 Modal）。paintingClasses 从 ① paintingPrimitives import。
 */
import PaintingSkeletonSurface from '@renderer/pages/paintings/components/PaintingSkeletonSurface'
import type { PaintingData } from '@renderer/pages/paintings/model/types/paintingData'
import { paintingClasses } from '@renderer/pages/paintings/paintingPrimitives'
import { getPaintingFileUrl } from '@renderer/pages/paintings/utils/paintingFileUrl'
// fork 缝：原 `import { Button, Modal } from 'antd'` —— historyAddButton 换回原生 button 后 Button 不再使用。
import { Modal } from 'antd'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import type { FC, UIEventHandler } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface PaintingStripProps {
  selectedPaintingId?: string
  /** Id of the painting with an in-flight generation, or undefined when idle. */
  runningPaintingId?: string
  items: PaintingData[]
  hasMore: boolean
  loadMore: () => void
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
        className={paintingClasses.historyDelete}
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
  hasMore,
  loadMore,
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
    if (hasMore && strip && strip.scrollHeight <= strip.clientHeight) {
      loadMore()
    }
  }, [hasMore, items.length, loadMore])

  return (
    <>
      <div ref={stripRef} className={paintingClasses.historyStrip} onScroll={handleScroll}>
        {/* fork 缝：V2 的 Button（@cherrystudio/ui）渲染原生 button、只吃 className；antd Button 的
            .ant-btn 自带 height/padding，会顶掉 paintingClasses.historyAddButton 的 h-11 w-11（44px）。
            换回原生 button：className/aria-label/onClick 逐字保留；antd 专有的 `icon` prop 无原生对应物，
            等价展开为子节点（antd 内部同样渲染 <span class="ant-btn-icon">{icon}</span>）。 */}
        <button
          type="button"
          className={paintingClasses.historyAddButton}
          aria-label={t('paintings.button.new.image')}
          onClick={onAddPainting}>
          <Plus className="size-4" />
        </button>
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
        {hasMore && <Loader2 className="mx-auto size-4 shrink-0 animate-spin text-foreground-tertiary" aria-hidden />}
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
