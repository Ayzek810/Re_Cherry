import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface UseNotesFileUploadProps {
  onUploadFiles: (files: File[]) => void
  setIsDragOverSidebar: (isDragOver: boolean) => void
}

/**
 * 读完一个目录条目的**全部**子项。
 *
 * `FileSystemDirectoryReader.readEntries()` 按规范分批返回（Chromium 每批 100 项），
 * 只有拿到空批次才代表读完。二轮审查 f2-35/f2-37：旧实现只读第一批，拖入 100+ 项的
 * 文件夹时后 100 项被静默丢弃，页面照常弹"上传成功"。
 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
            return
          }
          all.push(...batch)
          readBatch()
        },
        (error) => reject(error)
      )
    }
    readBatch()
  })
}

export const useNotesFileUpload = ({ onUploadFiles, setIsDragOverSidebar }: UseNotesFileUploadProps) => {
  const { t } = useTranslation()

  const handleDropFiles = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOverSidebar(false)

      // 处理文件夹拖拽：从 dataTransfer.items 获取完整文件路径信息
      const items = Array.from(e.dataTransfer.items)
      const files: File[] = []

      const processEntry = async (entry: FileSystemEntry, path: string = '') => {
        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry
          return new Promise<void>((resolve) => {
            fileEntry.file((file) => {
              // 手动设置 webkitRelativePath 以保持文件夹结构
              Object.defineProperty(file, 'webkitRelativePath', {
                value: path + file.name,
                writable: false
              })
              files.push(file)
              resolve()
            })
          })
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry
          const reader = dirEntry.createReader()
          const entries = await readAllEntries(reader)
          await Promise.all(entries.map((subEntry) => processEntry(subEntry, path + entry.name + '/')))
        }
      }

      // 如果支持 DataTransferItem API（文件夹拖拽）
      if (items.length > 0 && items[0].webkitGetAsEntry()) {
        const promises = items.map((item) => {
          const entry = item.webkitGetAsEntry()
          return entry ? processEntry(entry) : Promise.resolve()
        })

        await Promise.all(promises)

        if (files.length === 0) {
          // §9：拖进来却什么都没上传，不得表现为"点了没反应"。
          window.toast.warning(t('notes.no_valid_files'))
          return
        }
        onUploadFiles(files)
      } else {
        const regularFiles = Array.from(e.dataTransfer.files)
        if (regularFiles.length > 0) {
          onUploadFiles(regularFiles)
        }
      }
    },
    [onUploadFiles, setIsDragOverSidebar, t]
  )

  const handleSelectFiles = useCallback(() => {
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.multiple = true
    fileInput.accept = '.md,.markdown'
    fileInput.webkitdirectory = false

    fileInput.onchange = (e) => {
      const target = e.target as HTMLInputElement
      if (target.files && target.files.length > 0) {
        const selectedFiles = Array.from(target.files)
        onUploadFiles(selectedFiles)
      }
      fileInput.remove()
    }

    fileInput.click()
  }, [onUploadFiles])

  const handleSelectFolder = useCallback(() => {
    const folderInput = document.createElement('input')
    folderInput.type = 'file'
    // @ts-ignore - webkitdirectory is a non-standard attribute
    folderInput.webkitdirectory = true
    // @ts-ignore - directory is a non-standard attribute
    folderInput.directory = true
    folderInput.multiple = true

    folderInput.onchange = (e) => {
      const target = e.target as HTMLInputElement
      if (target.files && target.files.length > 0) {
        const selectedFiles = Array.from(target.files)
        onUploadFiles(selectedFiles)
      }
      folderInput.remove()
    }

    folderInput.click()
  }, [onUploadFiles])

  return {
    handleDropFiles,
    handleSelectFiles,
    handleSelectFolder
  }
}
