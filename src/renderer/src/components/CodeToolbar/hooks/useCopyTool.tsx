import { loggerService } from '@logger'
import type { ActionTool } from '@renderer/components/ActionTools'
import { TOOL_SPECS, useToolManager } from '@renderer/components/ActionTools'
import { CopyIcon } from '@renderer/components/Icons'
import type { BasicPreviewHandles } from '@renderer/components/Preview'
import { useTemporaryValue } from '@renderer/hooks/useTemporaryValue'
import { Check, Image } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface UseCopyToolProps {
  showPreviewTools?: boolean
  previewRef: React.RefObject<BasicPreviewHandles | null>
  onCopySource: () => void
  setTools: React.Dispatch<React.SetStateAction<ActionTool[]>>
}

const logger = loggerService.withContext('useCopyTool')

export const useCopyTool = ({ showPreviewTools, previewRef, onCopySource, setTools }: UseCopyToolProps) => {
  const [copied, setCopiedTemporarily] = useTemporaryValue(false)
  const [copiedImage, setCopiedImageTemporarily] = useTemporaryValue(false)
  const { t } = useTranslation()
  const { registerTool, removeTool } = useToolManager(setTools)

  const handleCopySource = useCallback(() => {
    try {
      onCopySource()
      setCopiedTemporarily(true)
    } catch (error) {
      setCopiedTemporarily(false)
      throw error
    }
  }, [onCopySource, setCopiedTemporarily])

  const handleCopyImage = useCallback(() => {
    // c2-13：`copy()` 是异步的（内部 await svgToPngBlob + navigator.clipboard.write），
    // try/catch 看不见它的 rejection，`void` 又丢掉了 promise，于是对勾会在真正写进剪贴板
    // 之前就亮起。只在 promise resolve 之后才翻转成功态，失败给出可见信号。
    const copyPromise = previewRef.current?.copy()
    if (!copyPromise) {
      setCopiedImageTemporarily(false)
      return
    }
    copyPromise
      .then(() => setCopiedImageTemporarily(true))
      .catch((error: unknown) => {
        setCopiedImageTemporarily(false)
        logger.error('Failed to copy image:', error as Error)
        window.toast.error(t('code_block.copy.failed'))
      })
  }, [previewRef, setCopiedImageTemporarily, t])

  useEffect(() => {
    const includePreviewTools = showPreviewTools && previewRef.current !== null

    const baseTool = {
      ...TOOL_SPECS.copy,
      icon: copied ? (
        <Check className="tool-icon" color="var(--color-status-success)" />
      ) : (
        <CopyIcon className="tool-icon" />
      ),
      tooltip: t('code_block.copy.source'),
      onClick: handleCopySource
    }

    const copyImageTool = {
      ...TOOL_SPECS['copy-image'],
      icon: copiedImage ? (
        <Check className="tool-icon" color="var(--color-status-success)" />
      ) : (
        <Image className="tool-icon" />
      ),
      tooltip: t('preview.copy.image'),
      onClick: handleCopyImage
    }

    registerTool(baseTool)

    if (includePreviewTools) {
      registerTool(copyImageTool)
    }

    return () => {
      removeTool(TOOL_SPECS.copy.id)
      removeTool(TOOL_SPECS['copy-image'].id)
    }
  }, [
    onCopySource,
    registerTool,
    removeTool,
    t,
    copied,
    copiedImage,
    handleCopySource,
    handleCopyImage,
    showPreviewTools,
    previewRef
  ])
}
