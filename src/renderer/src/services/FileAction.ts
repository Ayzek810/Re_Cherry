import { loggerService } from '@logger'
import TextEditPopup from '@renderer/components/Popups/TextEditPopup'
import i18n from '@renderer/i18n'
import FileManager from '@renderer/services/FileManager'
import store from '@renderer/store'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { FileMetadata } from '@renderer/types'
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
  try {
    const file = await FileManager.getFile(fileId)
    if (!file) return

    // 删除纪律。`deleteFile` 返回布尔；这里把 `false` 转成 throw，有两个原因：
    //   ① 页面侧的批量删除（`pages/files/batchDelete.ts` 的 `runBatchDelete`）按 **rejection**
    //      区分成败——若这里静默返回，盘上删失败的文件会被计入"N 成功"；
    //   ② 单条删除的 Popconfirm/module.confirm 调用点本来就靠异常冒泡。
    // 失败时跳过 Redux 块引用的清理（行要能被恢复）。
    const deleted = await FileManager.deleteFile(fileId, true)
    if (!deleted) {
      throw new Error(`FileManager.deleteFile returned false for ${fileId}`)
    }

    // Dexie 已废弃：从 Redux 清理引用该文件的块（块数据由内核事件驱动）
    try {
      const state = store.getState()
      const relatedBlockIds = Object.values(state.messageBlocks.entities)
        .filter((block) => {
          if (!block) return false
          if (block.type === 'file' || block.type === 'image') {
            return block.file?.id === fileId
          }
          return false
        })
        .map((block) => block.id)

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
  } catch (error) {
    // 每条失败路径都要有用户可见信号，且只在这里给一次。`deleteFile → false`、Dexie 读失败、
    // IPC 断链都落到这个出口。`t` 由调用点传入正是为此；调用方只需接住 rejection，不再重复弹提示。
    logger.warn(`FileAction.handleDelete failed for ${fileId}`, error as Error)
    window.toast.error(t('files.delete.db_error'))
    throw error
  }
}

// 重命名操作
export async function handleRename(fileId: string) {
  const file = await FileManager.getFile(fileId)
  if (!file) return
  const newName = await TextEditPopup.show({ text: file.origin_name })
  if (!newName) return

  // Dexie 写入是持久化操作，`void` 之后既无 await 也无 catch —— 写失败只能是
  // unhandled rejection，而文件页已按新名渲染。这里 await + catch，落 warn 并弹可见错误。
  try {
    await FileManager.updateFile({ ...file, origin_name: newName })
  } catch (error) {
    logger.warn(`FileAction.handleRename: failed to persist new name for ${fileId}`, error as Error)
    window.toast.error(i18n.t('files.rename.error', { defaultValue: 'Failed to rename the file' }))
  }
}
