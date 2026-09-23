/**
 * 模板轮播（v0.3.3 批次4，② 薄适配）：5 卡轮播原样（位置/旋转/缩放表保留）；
 * 资源路径同 usePaintingTemplateCatalog（file:// URL，resources/painting-templates）。
 * NormalTooltip → antd Tooltip。
 */
import type { PaintingTemplatePreset } from '@renderer/pages/paintings/hooks/usePaintingTemplateCatalog'
// fork 缝：原 `import { Button, Tooltip } from 'antd'` —— 轮播卡换回原生 button 后 Button 不再使用。
import { Tooltip } from 'antd'
import { type FC, useState } from 'react'
import { useTranslation } from 'react-i18next'

const carouselPositions = [
  {
    x: 'calc(-50% - 23cqw)',
    y: 'calc(-50% + 8px)',
    rotation: '-7deg',
    scale: 0.82,
    className: 'z-10 opacity-70'
  },
  {
    x: 'calc(-50% - 11.5cqw)',
    y: 'calc(-50% + 3px)',
    rotation: '-3deg',
    scale: 0.92,
    className: 'z-20 opacity-90'
  },
  {
    x: '-50%',
    y: 'calc(-50% - 2px)',
    rotation: '0deg',
    scale: 1.12,
    className: 'z-40 opacity-100'
  },
  {
    x: 'calc(-50% + 11.5cqw)',
    y: 'calc(-50% + 3px)',
    rotation: '3deg',
    scale: 0.92,
    className: 'z-20 opacity-90'
  },
  {
    x: 'calc(-50% + 23cqw)',
    y: 'calc(-50% + 8px)',
    rotation: '7deg',
    scale: 0.82,
    className: 'z-10 opacity-70'
  }
] as const

interface PaintingTemplateShowcaseProps {
  paintingId: string
  prompt: string
  templates: readonly PaintingTemplatePreset[]
  onSelect: (prompt: string) => void
}

const PaintingTemplateShowcase: FC<PaintingTemplateShowcaseProps> = ({ paintingId, prompt, templates, onSelect }) => {
  const { t } = useTranslation()
  const [styleSelection, setStyleSelection] = useState<{ paintingId: string; presetId: string }>()
  const promptedStyleIndex = templates.findIndex((preset) => preset.prompt === prompt)
  const rememberedStyleIndex =
    styleSelection?.paintingId === paintingId
      ? templates.findIndex((preset) => preset.id === styleSelection.presetId)
      : -1
  const selectedStyleIndex = rememberedStyleIndex >= 0 ? rememberedStyleIndex : promptedStyleIndex
  const activeStyleIndex = selectedStyleIndex >= 0 ? selectedStyleIndex : 0

  return (
    <div
      className="relative flex max-h-[220px] min-h-0 w-full flex-1 items-center justify-center overflow-hidden [container-type:size]"
      role="group"
      aria-label={t('paintings.showcase.styles_label')}>
      {templates.map((preset, index) => {
        const isSelected = index === selectedStyleIndex
        const middlePosition = Math.floor(templates.length / 2)
        const relativePosition =
          ((index - activeStyleIndex + middlePosition + templates.length) % templates.length) - middlePosition
        const isHidden = Math.abs(relativePosition) > 2
        const visiblePosition = Math.max(-2, Math.min(2, relativePosition))
        const carouselPosition = carouselPositions[visiblePosition + 2] ?? carouselPositions[2]

        // fork 缝：V2 的 Button（@cherrystudio/ui，shadcn）渲染原生 button、只吃 className；fork 移植
        // 时换成 antd Button，而 .ant-btn 自带 height/padding/line-height（CSS-in-JS 注入晚于 Tailwind
        // 层）→ 覆盖下面的 clamp 尺寸类，卡片缩成 antd 默认约 40px 小图、横散在页面上。
        // 换回原生 button，只承载 V2 的尺寸/形状类；aria/tabIndex/style/onClick 逐字保留。
        // Tooltip 仍用 antd（V2 的 NormalTooltip → antd Tooltip，原样）。
        return (
          <Tooltip
            key={preset.id}
            title={preset.label}
            placement="top"
            styles={{ body: { maxWidth: 'none', whiteSpace: 'nowrap', padding: '4px 8px', fontWeight: 500 } }}
            {...(isSelected ? { open: true } : {})}>
            <button
              type="button"
              aria-pressed={isSelected}
              aria-hidden={isHidden || undefined}
              aria-label={preset.label}
              tabIndex={isHidden ? -1 : 0}
              className={`group absolute top-1/2 left-1/2 h-[clamp(44px,min(18cqw,66cqh),148px)] w-[clamp(36px,min(14cqw,53cqh),118px)] overflow-visible rounded-xl p-0 opacity-100 transition-[transform,opacity,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform hover:z-50 hover:bg-transparent hover:shadow-lg focus-visible:z-50 focus-visible:ring-2 focus-visible:ring-muted-foreground focus-visible:ring-inset focus-visible:ring-offset-0 ${
                carouselPosition.className
              } ${isHidden ? 'pointer-events-none opacity-0' : ''} ${isSelected ? 'shadow-md' : ''}`}
              style={{
                transform: `translate(${carouselPosition.x}, ${carouselPosition.y}) rotate(${carouselPosition.rotation}) scale(${carouselPosition.scale})`
              }}
              onClick={() => {
                setStyleSelection({ paintingId, presetId: preset.id })
                onSelect(preset.prompt)
              }}>
              <span className="pointer-events-none relative size-full overflow-hidden rounded-xl bg-card">
                {preset.imageUrl ? (
                  <img src={preset.imageUrl} alt="" draggable={false} className="size-full object-cover" />
                ) : (
                  <span
                    aria-hidden
                    className="absolute inset-0 bg-[linear-gradient(145deg,var(--muted),transparent_58%)]"
                  />
                )}
              </span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

export default PaintingTemplateShowcase
