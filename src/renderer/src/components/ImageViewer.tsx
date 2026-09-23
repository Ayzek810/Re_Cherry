import {
  CopyOutlined,
  DownloadOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  SwapOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined
} from '@ant-design/icons'
import { loggerService } from '@logger'
import { download } from '@renderer/utils/download'
import { convertImageToPng } from '@renderer/utils/image'
import { parseDataUrl } from '@shared/utils'
import type { ImageProps as AntImageProps } from 'antd'
import { Dropdown, Image as AntImage, Space } from 'antd'
import { Base64 } from 'js-base64'
import { DownloadIcon } from 'lucide-react'
import mime from 'mime'
import React from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { CopyIcon } from './Icons'

interface ImageViewerProps extends AntImageProps {
  src: string
}

const logger = loggerService.withContext('ImageViewer')

const ImageViewer: React.FC<ImageViewerProps> = ({ src, style, ...props }) => {
  const { t } = useTranslation()

  // 复制图片到剪贴板
  const handleCopyImage = async (src: string) => {
    try {
      let blob: Blob

      if (src.startsWith('data:')) {
        // 处理 base64 格式的图片 - 使用 parseDataUrl 避免正则匹配大字符串导致OOM
        const parseResult = parseDataUrl(src)
        if (!parseResult || !parseResult.mediaType || !parseResult.isBase64) {
          throw new Error('Invalid base64 image format')
        }
        const byteArray = Base64.toUint8Array(parseResult.data)
        blob = new Blob([byteArray.slice()], { type: parseResult.mediaType })
      } else if (src.startsWith('file://')) {
        // 处理本地文件路径
        const bytes = await window.api.fs.read(src)
        const mimeType = mime.getType(src) || 'application/octet-stream'
        blob = new Blob([bytes], { type: mimeType })
      } else {
        // 处理 URL 格式的图片
        const response = await fetch(src)
        blob = await response.blob()
      }

      // 统一转换为 PNG 以确保兼容性（剪贴板 API 不支持 JPEG）
      const pngBlob = await convertImageToPng(blob)

      const item = new ClipboardItem({
        'image/png': pngBlob
      })
      await navigator.clipboard.write([item])

      window.toast.success(t('message.copy.success'))
    } catch (error) {
      const err = error as Error
      logger.error(`Failed to copy image: ${err.message}`, { stack: err.stack })
      window.toast.error(t('message.copy.failed'))
    }
  }

  const getContextMenuItems = (src: string, size: number = 14) => {
    return [
      {
        key: 'copy-image',
        label: t('common.copy'),
        icon: <CopyIcon size={size} />,
        onClick: () => handleCopyImage(src)
      },
      {
        key: 'copy-url',
        label: t('preview.copy.src'),
        icon: <CopyIcon size={size} />,
        onClick: () => {
          void navigator.clipboard.writeText(src)
          window.toast.success(t('message.copy.success'))
        }
      },
      {
        key: 'download',
        label: t('common.download'),
        icon: <DownloadIcon size={size} />,
        onClick: () => download(src)
      }
    ]
  }

  // fork 缝（v0.3.3-10）：`preview === false` 的调用方（画板 Artboard：图要 pan/zoom，明确不要灯箱）
  // 渲染**裸 `<img>`** —— 这正是 V2 `components/ImageViewer.tsx:254-268` 的形态：`className`/`style`
  // 直接落在 `<img>` 上。走 antd Image 时它们落在 rc-image 的包裹 div 上（只有 `COMMON_PROPS`
  // 会到 img），于是调用方的 `max-h-full`/`max-w-full`/`object-contain` 与 `onLoad` 全部失效 ——
  // 图片因此"按宽度撑满 + 顶部对齐 + 被容器裁掉"。裸 img 之后这些语义与 V2 一致。
  if (props.preview === false) {
    const {
      preview: _preview,
      wrapperClassName: _wrapperClassName,
      wrapperStyle: _wrapperStyle,
      rootClassName: _rootClassName,
      fallback: _fallback,
      placeholder: _placeholder,
      previewPrefixCls: _previewPrefixCls,
      onPreviewClose: _onPreviewClose,
      ...imgProps
    } = props
    return (
      <Dropdown menu={{ items: getContextMenuItems(src) }} trigger={['contextMenu']}>
        <img src={src} style={style} {...imgProps} onContextMenu={(e) => e.stopPropagation()} />
      </Dropdown>
    )
  }

  return (
    <Dropdown menu={{ items: getContextMenuItems(src) }} trigger={['contextMenu']}>
      <AntImage
        src={src}
        style={style}
        onContextMenu={(e) => e.stopPropagation()}
        {...props}
        preview={{
          mask: typeof props.preview === 'object' ? props.preview.mask : false,
          ...(typeof props.preview === 'object' ? props.preview : {}),
          toolbarRender: (
            _,
            {
              transform: { scale },
              actions: { onFlipY, onFlipX, onRotateLeft, onRotateRight, onZoomOut, onZoomIn, onReset }
            }
          ) => (
            <ToolbarWrapper size={12} className="toolbar-wrapper">
              <SwapOutlined rotate={90} onClick={onFlipY} />
              <SwapOutlined onClick={onFlipX} />
              <RotateLeftOutlined onClick={onRotateLeft} />
              <RotateRightOutlined onClick={onRotateRight} />
              <ZoomOutOutlined disabled={scale === 1} onClick={onZoomOut} />
              <ZoomInOutlined disabled={scale === 50} onClick={onZoomIn} />
              <UndoOutlined onClick={onReset} />
              <CopyOutlined onClick={() => handleCopyImage(src)} />
              <DownloadOutlined onClick={() => download(src)} />
            </ToolbarWrapper>
          )
        }}
      />
    </Dropdown>
  )
}

const ToolbarWrapper = styled(Space)`
  padding: 0px 24px;
  color: #fff;
  font-size: 20px;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 100px;
  .anticon {
    padding: 12px;
    cursor: pointer;
  }
  .anticon:hover {
    opacity: 0.3;
  }
`

export default ImageViewer
