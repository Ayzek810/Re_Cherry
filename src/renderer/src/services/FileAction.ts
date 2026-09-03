import { loggerService } from '@logger'
import TextEditPopup from '@renderer/components/Popups/TextEditPopup'
import FileManager from '@renderer/services/FileManager'
import store from '@renderer/store'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock, ImageMessageBlock } from '@renderer/types/newMessage'
import dayjs from 'dayjs'

// 排序相关
export type SortField = 'created_at' | 'size' | 'name'
export type SortOrder = 'asc' | 'desc'

const logger = loggerService.withContext('FileAction')

export function tempFilesSort(files: FileMetadata[]): FileMetadata[] {
  return files.sort((a, b) => {
    const aIsTemp = a.origin_name.startsWith('temp_file')
    const bIsTemp = b.origin_name.startsWith('temp_file')
    if (aIsTemp && !bIsTemp) return 1
    if (!aIsTemp && bIsTemp) return -1
    return 0
  })
}

export function sortFiles(files: FileMetadata[], sortField: SortField, sortOrder: SortOrder): FileMetadata[] {
  return [...files].sort((a, b) => {
    let comparison = 0
    switch (sortField) {
      case 'created_at':
        comparison = dayjs(a.created_at).unix() - dayjs(b.created_at).unix()
        break
      case 'size':
        comparison = a.size - b.size
        break
      case 'name':
        comparison = a.origin_name.localeCompare(b.origin_name)
        break
    }
    return sortOrder === 'asc' ? comparison : -comparison
  })
}

// 删除操作
export async function handleDelete(fileId: string, t: (key: string) => string) {
  const file = await FileManager.getFile(fileId)
  if (!file) return

  await FileManager.deleteFile(fileId, true)

  // Dexie 已废弃：从 Redux 清理引用该文件的块（块数据由内核事件驱动）
  try {
    const state = store.getState()
    const relatedBlockIds = Object.values(state.messageBlocks.entities)
      .filter((block) => {
        if (!block) return false
        if (block.type === 'file' || block.type === 'image') {
          return (block as FileMessageBlock | ImageMessageBlock).file?.id === fileId
        }
        return false
      })
      .map((block) => block!.id)

    if (relatedBlockIds.length === 0) {
      return
    }

    // 从各话题消息的 blocks 数组移除
    for (const topicId of Object.keys(state.messages.messageIdsByTopic)) {
      const messageIds = state.messages.messageIdsByTopic[topicId] ?? []
      for (const messageId of messageIds) {
        const message = state.messages.entities[messageId]
        if (message && message.blocks?.some((id) => relatedBlockIds.includes(id))) {
          store.dispatch(
            newMessagesActions.updateMessage({
              topicId,
              messageId,
              updates: { blocks: message.blocks.filter((id) => !relatedBlockIds.includes(id)) }
            })
          )
        }
      }
    }
    store.dispatch(removeManyBlocks(relatedBlockIds))
    logger.info(`Removed ${relatedBlockIds.length} blocks referencing file ${fileId} from Redux`)
  } catch (err) {
    logger.error(`Error removing file blocks for ${fileId}:`, err as Error)
    window.modal.error({ content: t('files.delete.db_error'), centered: true })
  }
}

// 重命名操作
export async function handleRename(fileId: string) {
  const file = await FileManager.getFile(fileId)
  if (!file) return
  const newName = await TextEditPopup.show({ text: file.origin_name })
  if (newName) {
    void FileManager.updateFile({ ...file, origin_name: newName })
  }
}
