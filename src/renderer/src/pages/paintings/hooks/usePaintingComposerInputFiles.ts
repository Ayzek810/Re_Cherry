/**
 * 参考图托盘状态 hook（v0.3.3 批次4，V2 usePaintingComposerInputFiles 重写）：
 * 页面自持 inputFiles: FileMetadata[] 状态 + window.api.file.select 图片选择。
 * V2 三动作语义保留（框架词汇替换：ComposerAttachment/FileEntry → FileMetadata）：
 * - SEED：painting 切换时把该画 inputFiles 投影进托盘（一次）。
 * - MATERIALIZE：generate 时把托盘内容物化（fork 缝里 FileMetadata 已是最终
 *   形态，无 promote 步骤；complete 恒 true，保留返回形状给 ② submit 用）。
 * - CLEAR：模型/服务商切到不收图时清空托盘（V2 CLEAR 语义）。
 */
import FileManager from '@renderer/services/FileManager'
import { loggerService } from '@renderer/services/LoggerService'
import type { FileMetadata } from '@renderer/types'
import { imageExts } from '@shared/config/constant'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('usePaintingComposerInputFiles')

/** 当前模型是否收图：'unknown' = 模型未解析（不动托盘）。 */
export type InputCapability = 'unknown' | 'accept' | 'reject'

const IMAGE_SELECT_FILTERS = [
  { name: 'Images', extensions: imageExts.map((ext) => ext.replace(/^\./, '')) }
]

interface Params {
  paintingId: string
  /** 当前画作的存档输入（历史回灌源）。 */
  archivedInputFiles: FileMetadata[]
  inputCapability: InputCapability
  providerId: string | undefined
}

export interface MaterializedInputs {
  files: FileMetadata[]
  complete: boolean
}

export function usePaintingComposerInputFiles({ paintingId, archivedInputFiles, inputCapability, providerId }: Params) {
  const { t } = useTranslation()
  const [inputFiles, setInputFiles] = useState<FileMetadata[]>([])
  const [selecting, setSelecting] = useState(false)
  const seededPaintingIdRef = useRef<string | null>(null)
  const lastCapabilityRef = useRef<'accept' | 'reject' | null>(null)
  const lastProviderIdRef = useRef<string | undefined>(providerId)

  // SEED — 一次每 painting：把存档输入投影进托盘。
  useEffect(() => {
    if (seededPaintingIdRef.current === paintingId) return
    seededPaintingIdRef.current = paintingId
    setInputFiles(archivedInputFiles)
    // archivedInputFiles 只在 SEED 时读：后续变化（重新生成）不覆盖用户草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintingId])

  // CLEAR — 同 painting 的模型/服务商切换对账（V2 语义：能力降级或换 provider 即清）。
  useEffect(() => {
    const providerChanged = lastProviderIdRef.current !== providerId
    lastProviderIdRef.current = providerId
    const droppedImageSupport = lastCapabilityRef.current === 'accept' && inputCapability === 'reject'
    if (inputCapability !== 'unknown') lastCapabilityRef.current = inputCapability
    if (!providerChanged && !droppedImageSupport) return
    setInputFiles([])
  }, [inputCapability, providerId])

  const addFiles = useCallback((files: FileMetadata[]) => {
    if (files.length === 0) return
    setInputFiles((prev) => {
      const seen = new Set(prev.map((file) => file.id))
      return [...prev, ...files.filter((file) => !seen.has(file.id))]
    })
  }, [])

  const removeFile = useCallback((id: string) => {
    setInputFiles((prev) => prev.filter((file) => file.id !== id))
  }, [])

  const clearFiles = useCallback(() => {
    setInputFiles([])
  }, [])

  /** 打开系统图片选择框（多选），选中即入托盘。 */
  const pickImages = useCallback(async () => {
    if (selecting) return
    setSelecting(true)
    try {
      const picked = await window.api.file.select({ properties: ['openFile', 'multiSelections'], filters: IMAGE_SELECT_FILTERS })
      if (picked?.length) {
        addFiles(picked)
      }
    } finally {
      setSelecting(false)
    }
  }, [addFiles, selecting])

  /**
   * MATERIALIZE — generate 时调用。fork 缝里 FileMetadata 已是最终形态：
   * 引用计数入库（addFile）保证记录被 paintings 表引用期间文件不被清仓。
   */
  const materializeInputs = useCallback(async (): Promise<MaterializedInputs> => {
    const files = inputFiles
    for (const file of files) {
      try {
        await FileManager.addFile(file)
      } catch (error) {
        // 单个入库失败不阻塞生成（文件可能已在仓内）；记录告警即可。
        logger.warn('addFile failed for input file', error as Error, { fileId: file.id })
      }
    }
    return { files, complete: true }
  }, [inputFiles])

  return {
    inputFiles,
    setInputFiles,
    addFiles,
    removeFile,
    clearFiles,
    pickImages,
    selecting,
    inputCapability,
    materializeInputs,
    t
  }
}
