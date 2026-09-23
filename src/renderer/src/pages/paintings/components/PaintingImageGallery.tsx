/**
 * 生成结果图托盘（v0.3.3 批次4，V2 PaintingImageGallery 重写为 antd 版）：
 * 页面状态托盘（生成结果图列表）+ antd Image 预览 + 下载/保存按钮。
 * 布局参考 V2 HorizontalScrollContainer（fork 既有同名组件）。
 * 另含参考图托盘（编辑输入）：V2 同文件 PaintingImageAddButton 语义。
 */
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import { getPaintingFileUrl } from '@renderer/pages/paintings/utils/paintingFileUrl'
import type { FileMetadata } from '@renderer/types'
import { download } from '@renderer/utils/download'
import { Button, Image, Tooltip } from 'antd'
import { X } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

// ---- 参考图托盘（编辑输入；页面自持 inputFiles） ----

export const PaintingImageAddButton: FC<{ onPick: () => void; selecting: boolean }> = ({ onPick, selecting }) => {
  const { t } = useTranslation()
  // fork 缝：AddButton 已换成原生 button（styled(Button) → styled.button，见本文件下部定义）：
  // V2 的按钮只吃 className，antd .ant-btn 的 height/padding/border 会与那条 36px 圆形加图按钮打架。
  // antd 专有的 `icon` prop 无原生对应物，等价展开为子节点（antd 内部即 <span class="ant-btn-icon">）。
  // disabled 走原生 disabled；onClick/aria-label 逐字保留。
  return (
    <Tooltip title={t('paintings.add_image')}>
      <AddButton type="button" disabled={selecting} onClick={onPick} aria-label={t('paintings.add_image')}>
        <PlusOutlined />
      </AddButton>
    </Tooltip>
  )
}

export const PaintingInputTray: FC<{
  files: FileMetadata[]
  onRemove: (id: string) => void
}> = ({ files, onRemove }) => {
  const { t } = useTranslation()
  if (files.length === 0) return null
  return (
    <TrayWrap>
      <HorizontalScrollContainer dependencies={[files.length]} gap="6px">
        {files.map((file) => (
          <Tile key={file.id}>
            <TileImage src={getPaintingFileUrl(file)} alt={file.origin_name} preview={false} />
            <RemoveButton
              type="button"
              aria-label={t('common.delete')}
              title={t('common.delete')}
              onClick={(event) => {
                event.stopPropagation()
                onRemove(file.id)
              }}>
              <X size={12} />
            </RemoveButton>
          </Tile>
        ))}
      </HorizontalScrollContainer>
    </TrayWrap>
  )
}

// ---- 生成结果托盘（页面状态；antd Image 预览 + 下载） ----

interface PaintingImageGalleryProps {
  files: FileMetadata[]
}

const PaintingImageGallery: FC<PaintingImageGalleryProps> = ({ files }) => {
  const { t } = useTranslation()
  if (files.length === 0) return null
  return (
    <GalleryWrap>
      <HorizontalScrollContainer dependencies={[files.length]} gap="8px">
        {files.map((file) => (
          <ResultTile key={file.id}>
            <ResultImage src={getPaintingFileUrl(file)} alt={file.origin_name} />
            <DownloadButton
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              aria-label={t('common.download')}
              title={t('common.download')}
              onClick={(event) => {
                event.stopPropagation()
                download(getPaintingFileUrl(file))
              }}
            />
          </ResultTile>
        ))}
      </HorizontalScrollContainer>
    </GalleryWrap>
  )
}

const TrayWrap = styled.div`
  padding: 8px 12px 0;
`

const Tile = styled.span`
  position: relative;
  display: inline-flex;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 8px;
  border: 0.5px solid var(--color-border);

  &:hover .tile-remove {
    opacity: 1;
  }
`

const TileImage = styled(Image)`
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;

  .ant-image-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`

const RemoveButton = styled.button.attrs({ className: 'tile-remove' })`
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
`

// fork 缝：V2 的按钮是原生 button（@cherrystudio/ui Button，只吃 className），fork 曾用 antd Button，
// 其 .ant-btn 的 height/padding/border/border-radius 会覆盖下面这条 36px 圆形按钮的声明（同为单类
// 特异度、注入顺序决定胜负）。改 styled.button，样式对象逐字不变（display 本已是 inline-flex）。
const AddButton = styled.button`
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 0.5px dashed var(--color-border);
  color: var(--color-text-3);
  background: transparent;

  &:hover:not(:disabled) {
    border-color: var(--color-primary);
    color: var(--color-primary) !important;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`

const GalleryWrap = styled.div`
  padding: 4px 0;
`

const ResultTile = styled.div`
  position: relative;
  display: inline-flex;
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 10px;
  border: 0.5px solid var(--color-border);

  &:hover .tile-download {
    opacity: 1;
  }
`

const ResultImage = styled(Image)`
  width: 100%;
  height: 100%;

  .ant-image-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    cursor: zoom-in;
  }
`

const DownloadButton = styled(Button).attrs({ className: 'tile-download' })`
  position: absolute;
  right: 4px;
  bottom: 4px;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;

  &:hover {
    background: rgba(0, 0, 0, 0.65) !important;
    color: #fff !important;
  }
`

export default PaintingImageGallery
