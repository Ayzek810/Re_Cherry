/**
 * v0.3.2 自 CS_V1 移植（知识库 hooks；批次4 接真实处理链：extract → chunk → embed → 落库）。
 * fork 改动点：
 * - 不移植上游 KnowledgeQueue 全套：条目处理经 knowledgeBaseApi.add（主进程 FIFO 串行），
 *   状态机 pending → processing → completed/failed 直接回填 redux；
 * - file/url/note 三类进处理链；sitemap/directory/video 仅 redux 记录不处理（批次4 后置，
 *   交付注记有记）；笔记内容按 fork KnowledgeNoteItem 形状直接存于条目 content；
 * - 嵌入引用只含 {providerId, modelId, dimensions}，密钥主进程自解析（fork 偏离上游）。
 */
import FileManager from '@renderer/services/FileManager'
import { getEmbeddingRef, knowledgeBaseApi } from '@renderer/services/knowledgeBaseApi'
import type { RootState } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import {
  addBase,
  addFiles as addFilesAction,
  addItem as addItemAction,
  clearAllProcessing,
  clearCompletedProcessing,
  deleteBase,
  removeItem as removeItemAction,
  renameBase,
  updateBase,
  updateBases,
  updateItem as updateItemAction,
  updateItemProcessingStatus,
  updateNotes
} from '@renderer/store/knowledge'
import type { FileMetadata, KnowledgeBase, KnowledgeItem, KnowledgeNoteItem, ProcessingStatus } from '@renderer/types'
import { isKnowledgeFileItem, isKnowledgeNoteItem, isKnowledgeVideoItem } from '@renderer/types'
import { cloneDeep } from 'lodash'
import { useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { v4 as uuidv4 } from 'uuid'

import { useAssistants } from './useAssistant'

/** 创建一个新知识库条目（批次4：file/url/note 预置 processingStatus='pending'，进处理链）。 */
const createKnowledgeItem = (
  type: KnowledgeItem['type'],
  content: KnowledgeItem['content'],
  overrides: Partial<KnowledgeItem> = {}
): KnowledgeItem => {
  const timestamp = Date.now()
  const queued = type === 'file' || type === 'url' || type === 'note'
  return {
    id: uuidv4(),
    type,
    content,
    created_at: timestamp,
    updated_at: timestamp,
    ...(queued ? { processingStatus: 'pending' as ProcessingStatus } : {}),
    ...overrides
  }
}

export const useKnowledge = (baseId: string) => {
  const dispatch = useAppDispatch()
  const base = useSelector((state: RootState) => state.knowledge.bases.find((b) => b.id === baseId))

  // 重命名知识库
  const renameKnowledgeBase = (name: string) => {
    dispatch(renameBase({ baseId, name }))
  }

  // 更新知识库
  const updateKnowledgeBase = (base: KnowledgeBase) => {
    dispatch(updateBase(base))
  }

  // 批次4：条目处理（主进程 FIFO；完成/失败回填 redux，嵌入引用只含 id）
  const enqueueItem = (item: KnowledgeItem, payload: Parameters<typeof knowledgeBaseApi.add>[0]['item']) => {
    if (!base) return
    const baseSnapshot = base
    dispatch(updateItemProcessingStatus({ baseId, itemId: item.id, status: 'processing' }))
    void knowledgeBaseApi
      .add({
        base: {
          id: baseSnapshot.id,
          chunkSize: baseSnapshot.chunkSize,
          chunkOverlap: baseSnapshot.chunkOverlap,
          documentCount: baseSnapshot.documentCount,
          // 文档处理服务商 id（V2 对齐：配置即路由——配置了服务商的库所有 PDF 整本
          // 走该服务商；主进程执行缝消费）。
          preprocessProviderId: baseSnapshot.preprocessProvider?.provider.id
        },
        item: payload,
        embedding: getEmbeddingRef(baseSnapshot)
      })
      .then((result) => {
        dispatch(
          updateItemAction({
            baseId,
            item: {
              ...item,
              uniqueId: result.uniqueId,
              uniqueIds: result.uniqueIds,
              processingStatus: 'completed',
              processingProgress: 1,
              processingError: undefined,
              updated_at: Date.now()
            }
          })
        )
      })
      .catch((error: unknown) => {
        dispatch(
          updateItemProcessingStatus({
            baseId,
            itemId: item.id,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        )
      })
  }

  // 批量添加文件
  const addFiles = (files: FileMetadata[]) => {
    const filesItems = files.map((file) => createKnowledgeItem('file', file))
    dispatch(addFilesAction({ baseId, items: filesItems }))
    for (const item of filesItems) {
      if (isKnowledgeFileItem(item)) {
        enqueueItem(item, { kind: 'file', baseId, itemId: item.id, filePath: item.content.path ?? '' })
      }
    }
  }

  // 添加笔记
  const addNote = async (content: string) => {
    const note = createKnowledgeItem('note', content)
    if (!isKnowledgeNoteItem(note)) {
      return
    }
    dispatch(updateNotes({ baseId, item: note }))
    enqueueItem(note, { kind: 'note', baseId, itemId: note.id, text: content })
  }

  // 添加URL
  const addUrl = (url: string) => {
    const item = createKnowledgeItem('url', url)
    dispatch(addItemAction({ baseId, item }))
    enqueueItem(item, { kind: 'url', baseId, itemId: item.id, url })
  }

  // 添加 Sitemap
  const addSitemap = (url: string) => {
    dispatch(addItemAction({ baseId, item: createKnowledgeItem('sitemap', url) }))
  }

  // Add directory support
  const addDirectory = (path: string) => {
    dispatch(addItemAction({ baseId, item: createKnowledgeItem('directory', path) }))
  }

  // add video support
  const addVideo = (files: FileMetadata[]) => {
    dispatch(addItemAction({ baseId, item: createKnowledgeItem('video', files) }))
  }

  // 更新笔记内容（fork：笔记正文在条目 content 上，纯 redux 更新）
  const updateNoteContent = async (noteId: string, content: string) => {
    const noteItem = base?.items.find((item) => item.id === noteId)
    if (noteItem) {
      dispatch(
        updateItemAction({
          baseId,
          item: { ...noteItem, content, updated_at: Date.now() }
        })
      )
    }
  }

  // 获取笔记内容（fork：直接取条目正文）
  const getNoteContent = async (noteId: string): Promise<KnowledgeNoteItem | undefined> => {
    const noteItem = base?.items.find((item) => item.id === noteId)
    return noteItem && isKnowledgeNoteItem(noteItem) ? noteItem : undefined
  }

  const updateItem = (item: KnowledgeItem) => {
    dispatch(updateItemAction({ baseId, item }))
  }

  // 移除项目（批次4：向量条目按 uniqueIds 整批删 + redux 移除 + 文件清理）
  const removeItem = async (item: KnowledgeItem) => {
    dispatch(removeItemAction({ baseId, item }))

    if (base && item?.uniqueIds && item.uniqueIds.length > 0) {
      await knowledgeBaseApi.remove(baseId, item.uniqueIds)
    } else if (base && item?.uniqueId) {
      await knowledgeBaseApi.remove(baseId, [item.uniqueId])
    }

    if (isKnowledgeFileItem(item) && typeof item.content === 'object' && !Array.isArray(item.content)) {
      const file = item.content
      // name: eg. text.pdf
      await FileManager.deleteFiles([file])
    } else if (isKnowledgeVideoItem(item)) {
      // video item has srt and video files
      const files = item.content
      await FileManager.deleteFiles(files)
    }
  }

  // 刷新项目（批次4：remove + 重新入队嵌入；处理中条目拒绝重刷）
  const refreshItem = async (item: KnowledgeItem) => {
    const status = getProcessingStatus(item.id)

    if (status === 'pending' || status === 'processing') {
      return
    }

    if (!base) {
      return
    }

    const uniqueIds = item?.uniqueIds ?? (item?.uniqueId ? [item.uniqueId] : [])
    if (uniqueIds.length > 0) {
      await knowledgeBaseApi.remove(baseId, uniqueIds)
    }

    // 重新入队（file/url/note 三类可处理；其余类型批次4 后置，仅复位状态不处理）
    if (isKnowledgeFileItem(item)) {
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'file', baseId, itemId: item.id, filePath: item.content.path ?? '' }
      )
    } else if (isKnowledgeNoteItem(item)) {
      enqueueItem(
        { ...item, processingStatus: 'pending' },
        { kind: 'note', baseId, itemId: item.id, text: item.content }
      )
    } else if (item.type === 'url' && typeof item.content === 'string') {
      enqueueItem({ ...item, processingStatus: 'pending' }, { kind: 'url', baseId, itemId: item.id, url: item.content })
    }
  }

  // 更新处理状态
  const updateItemStatus = (itemId: string, status: ProcessingStatus, progress?: number, error?: string) => {
    dispatch(
      updateItemProcessingStatus({
        baseId,
        itemId,
        status,
        progress,
        error
      })
    )
  }

  // 获取特定项目的处理状态
  const getProcessingStatus = useCallback(
    (itemId: string) => {
      return base?.items.find((item) => item.id === itemId)?.processingStatus
    },
    [base?.items]
  )

  // 获取特定类型的所有处理项
  const getProcessingItemsByType = (type: 'file' | 'url' | 'note') => {
    return base?.items.filter((item) => item.type === type && item.processingStatus !== undefined) || []
  }

  // 清除已完成的项目
  const clearCompleted = () => {
    dispatch(clearCompletedProcessing({ baseId }))
  }

  // 清除所有处理状态
  const clearAll = () => {
    dispatch(clearAllProcessing({ baseId }))
  }

  // 迁移知识库（保留原知识库；批次1：条目按原内容纯复制，不触发重新处理）
  const migrateBase = async (newBase: KnowledgeBase) => {
    if (!base) return

    const timestamp = Date.now()
    const newName = `${newBase.name || base.name}-${timestamp}`

    const migratedBase: KnowledgeBase = {
      ...cloneDeep(base), // 深拷贝原始知识库
      ...newBase,
      id: newBase.id, // 确保使用新的ID
      name: newName,
      created_at: timestamp,
      updated_at: timestamp,
      items: []
    }

    dispatch(addBase(migratedBase))

    const files: FileMetadata[] = []

    // 遍历原知识库的 items，重新添加到新知识库
    for (const item of base.items) {
      switch (item.type) {
        case 'file':
          if (typeof item.content === 'object' && item.content !== null && 'path' in item.content) {
            files.push(item.content)
          }
          break
        case 'note':
          if (isKnowledgeNoteItem(item)) {
            dispatch(
              updateNotes({ baseId: newBase.id, item: createKnowledgeItem('note', item.content, { id: item.id }) })
            )
          } else {
            throw new Error(`Failed to migrate note item ${item.id}`)
          }
          break
        default:
          if (typeof item.content === 'string') {
            dispatch(addItemAction({ baseId: newBase.id, item: createKnowledgeItem(item.type, item.content) }))
          } else {
            throw new Error(`Not a valid item: ${JSON.stringify(item)}`)
          }
          break
      }
    }

    if (files.length > 0) {
      const filesItems = files.map((file) => createKnowledgeItem('file', file))
      dispatch(addFilesAction({ baseId: newBase.id, items: filesItems }))
    }
  }

  const fileItems = base?.items.filter((item) => item.type === 'file') || []
  const directoryItems = base?.items.filter((item) => item.type === 'directory') || []
  const urlItems = base?.items.filter((item) => item.type === 'url') || []
  const sitemapItems = base?.items.filter((item) => item.type === 'sitemap') || []
  const noteItems = base?.items.filter(isKnowledgeNoteItem) || []
  const videoItems = base?.items.filter((item) => item.type === 'video') || []

  return {
    base,
    fileItems,
    urlItems,
    sitemapItems,
    noteItems,
    videoItems,
    renameKnowledgeBase,
    updateKnowledgeBase,
    migrateBase,
    addFiles,
    addUrl,
    addSitemap,
    addNote,
    addVideo,
    updateNoteContent,
    getNoteContent,
    updateItem,
    updateItemStatus,
    refreshItem,
    getProcessingStatus,
    getProcessingItemsByType,
    clearCompleted,
    clearAll,
    removeItem,
    directoryItems,
    addDirectory
  }
}

export const useKnowledgeBases = () => {
  const dispatch = useDispatch()
  const bases = useSelector((state: RootState) => state.knowledge.bases)
  const { assistants, updateAssistants } = useAssistants()

  const addKnowledgeBase = (base: KnowledgeBase) => {
    dispatch(addBase(base))
    // 批次4：同步建向量库文件（LibSQL 单文件；失败仅日志——库文件在首次条目入队时也会惰性建）。
    void knowledgeBaseApi.create({ id: base.id }).catch(() => undefined)
  }

  const renameKnowledgeBase = (baseId: string, name: string) => {
    dispatch(renameBase({ baseId, name }))
  }

  const deleteKnowledgeBase = (baseId: string) => {
    const base = bases.find((b) => b.id === baseId)
    if (!base) return
    dispatch(deleteBase({ baseId }))

    // remove assistant knowledge_base
    // fork 分叉点：上游还会同步清理 assistant presets，fork 批次1 无 presets 状态
    const _assistants = assistants.map((assistant) => {
      if (assistant.knowledge_bases?.find((kb) => kb.id === baseId)) {
        return {
          ...assistant,
          knowledge_bases: assistant.knowledge_bases.filter((kb) => kb.id !== baseId)
        }
      }
      return assistant
    })

    updateAssistants(_assistants)
  }

  const updateKnowledgeBases = (bases: KnowledgeBase[]) => {
    dispatch(updateBases(bases))
  }

  return {
    bases,
    addKnowledgeBase,
    renameKnowledgeBase,
    deleteKnowledgeBase,
    updateKnowledgeBases
  }
}
