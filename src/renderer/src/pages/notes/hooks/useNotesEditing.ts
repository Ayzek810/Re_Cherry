import { loggerService } from '@logger'
import { useInPlaceEdit } from '@renderer/hooks/useInPlaceEdit'
import { fetchNoteSummary } from '@renderer/services/ApiService'
import type { NotesTreeNode } from '@renderer/types/note'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('UseNotesEditing')

interface UseNotesEditingProps {
  onRenameNode: (nodeId: string, newName: string) => void
}

export const useNotesEditing = ({ onRenameNode }: UseNotesEditingProps) => {
  const { t } = useTranslation()
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [renamingNodeIds, setRenamingNodeIds] = useState<Set<string>>(new Set())
  const [newlyRenamedNodeIds, setNewlyRenamedNodeIds] = useState<Set<string>>(new Set())

  const inPlaceEdit = useInPlaceEdit({
    onSave: (newName: string) => {
      if (editingNodeId && newName) {
        onRenameNode(editingNodeId, newName)
        window.toast.success(t('common.saved'))
        logger.debug(`Renamed node ${editingNodeId} to "${newName}"`)
      }
      setEditingNodeId(null)
    },
    onCancel: () => {
      setEditingNodeId(null)
    }
  })

  /**
   * f2-36：`useInPlaceEdit` 每次渲染都返回新对象，若把它放进 `handleStartEdit` 的依赖数组，
   * `handleStartEdit` 就每渲染换引用 → `useNotesMenu.getMenuItems` → `NotesActionsContext`
   * 一路跟着换 → `memo` 的 TreeNode 全量重渲染。方法本身逐次取最新即可，引用固定。
   */
  const inPlaceEditRef = useRef(inPlaceEdit)
  inPlaceEditRef.current = inPlaceEdit

  const handleStartEdit = useCallback((node: NotesTreeNode) => {
    setEditingNodeId(node.id)
    inPlaceEditRef.current.startEdit(node.name)
  }, [])

  const handleAutoRename = useCallback(
    async (note: NotesTreeNode) => {
      if (note.type !== 'file') return

      setRenamingNodeIds((prev) => new Set(prev).add(note.id))
      try {
        const content = await window.api.file.readExternal(note.externalPath)
        if (!content || content.trim().length === 0) {
          window.toast.warning(t('notes.auto_rename.empty_note'))
          return
        }

        const summaryText = await fetchNoteSummary({ content })
        if (summaryText) {
          onRenameNode(note.id, summaryText)
          window.toast.success(t('notes.auto_rename.success'))
        } else {
          window.toast.error(t('notes.auto_rename.failed'))
        }
      } catch (error) {
        window.toast.error(t('notes.auto_rename.failed'))
        logger.error(`Failed to auto-rename note: ${error}`)
      } finally {
        setRenamingNodeIds((prev) => {
          const next = new Set(prev)
          next.delete(note.id)
          return next
        })

        setNewlyRenamedNodeIds((prev) => new Set(prev).add(note.id))

        setTimeout(() => {
          setNewlyRenamedNodeIds((prev) => {
            const next = new Set(prev)
            next.delete(note.id)
            return next
          })
        }, 700)
      }
    },
    [onRenameNode, t]
  )

  return {
    editingNodeId,
    renamingNodeIds,
    newlyRenamedNodeIds,
    inPlaceEdit,
    handleStartEdit,
    handleAutoRename,
    setEditingNodeId
  }
}
