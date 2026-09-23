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
  return (
    <Tooltip title={t('paintings.add_image')}>
      <AddButton icon={<PlusOutlined />} disabled={selecting} onClick={onPick} aria-label={t('paintings.add_image')} />
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

const AddButton = styled(Button)`
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
