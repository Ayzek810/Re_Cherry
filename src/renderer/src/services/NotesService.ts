import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { setNotesPath } from '@renderer/store/note'
import type { NotesSortType, NotesTreeNode } from '@renderer/types/note'
import { getFileDirectory } from '@renderer/utils'

const logger = loggerService.withContext('NotesService')

const MARKDOWN_EXT = '.md'
let defaultNotesPathPromise: Promise<string> | null = null

export interface UploadResult {
  uploadedNodes: NotesTreeNode[]
  totalFiles: number
  skippedFiles: number
  fileCount: number
  folderCount: number
  /**
   * 写入失败的文件数。`0` 才是"全部成功"；主进程批量接口对单文件失败只记日志
   * 并把它排除在 `fileCount` 之外，旧实现把这个差额丢掉了——用户看到的是"上传成功"。
   */
  failedFiles: number
  /** 是否走了渲染层兼容路径（无 `file.path` 的浏览器 File 对象，或批量接口整体失败）。 */
  usedLegacyPath: boolean
}

export async function loadTree(rootPath: string): Promise<NotesTreeNode[]> {
  return window.api.file.getDirectoryStructure(normalizePath(rootPath))
}

export function sortTree(nodes: NotesTreeNode[], sortType: NotesSortType): NotesTreeNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    children: node.children ? sortTree(node.children, sortType) : undefined
  }))

  const sorter = getSorter(sortType)

  cloned.sort((a, b) => {
    if (a.type === b.type) {
      return sorter(a, b)
    }
    return a.type === 'folder' ? -1 : 1
  })

  return cloned
}

export async function addDir(name: string, parentPath: string): Promise<{ path: string; name: string }> {
  const resolved = await resolveNotesPath(parentPath)
  const basePath = resolved.path
  if (resolved.isFallback) {
    store.dispatch(setNotesPath(basePath))
  }
  const { safeName } = await window.api.file.checkFileName(basePath, name, false)
  const fullPath = `${basePath}/${safeName}`
  await window.api.file.mkdir(fullPath)
  return { path: fullPath, name: safeName }
}

export async function addNote(
  name: string,
  content: string = '',
  parentPath: string
): Promise<{ path: string; name: string }> {
  const resolved = await resolveNotesPath(parentPath)
  const basePath = resolved.path
  if (resolved.isFallback) {
    store.dispatch(setNotesPath(basePath))
  }
  const { safeName } = await window.api.file.checkFileName(basePath, name, true)
  const notePath = `${basePath}/${safeName}${MARKDOWN_EXT}`
  await window.api.file.write(notePath, content)
  return { path: notePath, name: safeName }
}

export interface ResolvedNotesPath {
  path: string // Resolved valid notes path.
  isFallback: boolean // Whether it falls back to the default notes path.
}

async function getDefaultNotesPath(): Promise<string> {
  if (!defaultNotesPathPromise) {
    defaultNotesPathPromise = window.api
      .getAppInfo()
      .then((appInfo) => normalizePath(appInfo.notesPath))
      .catch((error) => {
        defaultNotesPathPromise = null
        throw error
      })
  }

  return defaultNotesPathPromise
}
/**
 * Validate and resolve a notes path, including cross-platform restore scenarios.
 * This extracts NotesPage initialize logic to avoid duplicated path resolution code.
 * @param parentPath
 * @returns {ResolvedNotesPath} Resolved path and whether fallback to the default path occurred.
 */
export async function resolveNotesPath(parentPath: string): Promise<ResolvedNotesPath> {
  const basePath = normalizePath(parentPath || '')
  const defaultNotesPath = await getDefaultNotesPath()

  if (!basePath) {
    return {
      path: defaultNotesPath,
      isFallback: true
    }
  }

  if (basePath === defaultNotesPath) {
    return {
      path: basePath,
      isFallback: false
    }
  }

  try {
    const isValid = await window.api.file.validateNotesDirectory(basePath)
    if (isValid) {
      return {
        path: basePath,
        isFallback: false
      }
    }
  } catch (error) {
    logger.warn('Failed to validate notes directory, fallback to default', {
      basePath,
      error: (error as Error).message
    })

    return {
      path: defaultNotesPath,
      isFallback: true
    }
  }

  logger.warn('Invalid notes path, fallback to default', {
    invalidPath: basePath,
    defaultNotesPath
  })

  return {
    path: defaultNotesPath,
    isFallback: true
  }
}

/**
 * 删除节点。
 *
 * 删除纪律：返回 `Promise<boolean>`，调用方必须能区分成败。
 * 旧签名是 `Promise<void>`，页面结构上无法给出"删除失败"的信号，只能靠异常冒泡——而异常在
 * 页面 catch 里也只落日志。
 *
 * 主进程的两条删除 handler（`FileStorage.deleteExternalFile` / `deleteExternalDir`）对
 * "目标不存在"是**幂等成功**（`fs.existsSync` 早退、不抛错），只有真实 IO 失败才抛；因此这里
 * 成功一律 `true`，真实失败原样抛出交由调用方 presentToast。
 * @returns true = 已删除。
 * @throws 文件被占用、无权限、IPC 断链等真实失败。
 */
export async function delNode(node: NotesTreeNode): Promise<boolean> {
  if (node.type === 'folder') {
    await window.api.file.deleteExternalDir(node.externalPath)
  } else {
    await window.api.file.deleteExternalFile(node.externalPath)
  }
  return true
}

/**
 * 重命名节点的结果。
 *
 * `conflict` 是**业务结果**而非异常：改成已存在的名字是最常见的用户输入分支，
 * 旧实现把它 `throw new Error('Target name already exists')`，页面只能落一条日志，用户看到的是
 * "对话框关了、列表没变、什么都没有"。
 */
export type RenameNodeResult =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: 'conflict'; safeName: string }

/**
 * 重命名节点或笔记。
 * @returns `ok: false` + `reason: 'conflict'` = 目标名已存在（业务结果，调用方按提示分支处理）。
 * @throws 其余失败（占用、权限、IPC 断链）原样抛出。
 */
export async function renameNode(node: NotesTreeNode, newName: string): Promise<RenameNodeResult> {
  const isFile = node.type === 'file'
  const parentDir = normalizePath(getFileDirectory(node.externalPath))
  const { safeName, exists } = await window.api.file.checkFileName(parentDir, newName, isFile)

  if (exists) {
    logger.warn('Rename target name already exists', { path: node.externalPath, safeName })
    return { ok: false, reason: 'conflict', safeName }
  }

  if (isFile) {
    await window.api.file.rename(node.externalPath, safeName)
    return { ok: true, path: `${parentDir}/${safeName}${MARKDOWN_EXT}`, name: safeName }
  }

  await window.api.file.renameDir(node.externalPath, safeName)
  return { ok: true, path: `${parentDir}/${safeName}`, name: safeName }
}

export async function uploadNotes(files: File[], targetPath: string): Promise<UploadResult> {
  const basePath = normalizePath(targetPath)
  const totalFiles = files.length

  if (files.length === 0) {
    return {
      uploadedNodes: [],
      totalFiles: 0,
      skippedFiles: 0,
      fileCount: 0,
      folderCount: 0,
      failedFiles: 0,
      usedLegacyPath: false
    }
  }

  try {
    // Get file paths from File objects
    // For browser File objects from drag-and-drop, we need to use FileReader to save temporarily
    // However, for directory uploads, the files already have paths
    const filePaths: string[] = []

    for (const file of files) {
      // @ts-ignore - webkitRelativePath exists on File objects from directory uploads
      if (file.path) {
        // @ts-ignore - Electron File objects have .path property
        filePaths.push(file.path)
      } else {
        // For browser File API, we'd need to use FileReader and create temp files
        // For now, fall back to the old method for these cases
        logger.warn('File without path detected, using fallback method')
        return await runLegacyUpload(files, basePath, 'files without a native path')
      }
    }

    // Pause file watcher to prevent N refresh events
    await window.api.file.pauseFileWatcher()

    try {
      // Use the new optimized batch upload API that runs in Main process
      const result = await window.api.file.batchUploadMarkdown(filePaths, basePath)
      const failedFiles = Math.max(0, totalFiles - result.skippedFiles - result.fileCount)

      // 主进程按批 `allSettled`，成功数与总数/跳过数的差额就是失败数。旧实现把它丢掉，
      // 于是"3 成功 / 2 失败"在 UI 上与"5 成功"同形。
      if (failedFiles > 0) {
        logger.warn(
          `uploadNotes: batch upload finished with ${result.fileCount} succeeded / ${failedFiles} failed (skipped ${result.skippedFiles})`
        )
        window.toast.warning(
          i18n.t('notes.upload_partial', {
            defaultValue: '{{succeeded}} uploaded, {{failed}} failed',
            succeeded: result.fileCount,
            failed: failedFiles
          })
        )
      }

      return {
        uploadedNodes: [],
        totalFiles,
        skippedFiles: result.skippedFiles,
        fileCount: result.fileCount,
        folderCount: result.folderCount,
        failedFiles,
        usedLegacyPath: false
      }
    } finally {
      // Resume watcher and trigger single refresh
      await window.api.file.resumeFileWatcher()
    }
  } catch (error) {
    // 批量接口整体失败（mkdir / 读取中断 / IPC 断链）时才走兼容路径。此时主进程一个
    // 文件都没写成功（`fileCount` 只在成功返回时才有值），因此重传不会产生 `name (1).md` 副本。
    // 旧实现在 **任何** reject 上都无条件回退，且两条路径都不上报失败计数。
    logger.error('Batch upload failed as a whole, falling back to legacy method:', error as Error)
    window.toast.warning(
      i18n.t('notes.upload_fallback', {
        defaultValue: 'Batch upload failed. Retrying with the compatibility path.'
      })
    )
    return await runLegacyUpload(files, basePath, 'batch upload failed as a whole')
  }
}

/** 兼容路径的统一入口：记一条可取证日志，无论成功失败都把 `usedLegacyPath` 标出来。 */
async function runLegacyUpload(files: File[], basePath: string, reason: string): Promise<UploadResult> {
  logger.warn(`uploadNotes: using legacy renderer upload path (${reason})`)
  const result = await uploadNotesLegacy(files, basePath)
  return { ...result, usedLegacyPath: true }
}

/**
 * Legacy upload method using Renderer process
 * Kept as fallback for browser File API files without paths
 */
async function uploadNotesLegacy(files: File[], targetPath: string): Promise<UploadResult> {
  const basePath = normalizePath(targetPath)
  const markdownFiles = filterMarkdown(files)
  const skippedFiles = files.length - markdownFiles.length

  if (markdownFiles.length === 0) {
    return {
      uploadedNodes: [],
      totalFiles: files.length,
      skippedFiles,
      fileCount: 0,
      folderCount: 0,
      failedFiles: 0,
      usedLegacyPath: false
    }
  }

  const folders = collectFolders(markdownFiles, basePath)
  await createFolders(folders)

  let fileCount = 0
  let failedFiles = 0
  const BATCH_SIZE = 5 // Process 5 files concurrently to balance performance and responsiveness

  // Process files in batches to avoid blocking the UI thread
  for (let i = 0; i < markdownFiles.length; i += BATCH_SIZE) {
    const batch = markdownFiles.slice(i, i + BATCH_SIZE)

    // Process current batch in parallel
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const { dir, name } = resolveFileTarget(file, basePath)
        const { safeName } = await window.api.file.checkFileName(dir, name, true)
        const finalPath = `${dir}/${safeName}${MARKDOWN_EXT}`

        const content = await file.text()
        await window.api.file.write(finalPath, content)
        return true
      })
    )

    // Count successful uploads
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        fileCount += 1
      } else {
        failedFiles += 1
        logger.error('Failed to write uploaded file:', result.reason)
      }
    })

    // Yield to the event loop between batches to keep UI responsive
    if (i + BATCH_SIZE < markdownFiles.length) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return {
    uploadedNodes: [],
    totalFiles: files.length,
    skippedFiles,
    fileCount,
    folderCount: folders.size,
    failedFiles,
    usedLegacyPath: false
  }
}

function getSorter(sortType: NotesSortType): (a: NotesTreeNode, b: NotesTreeNode) => number {
  switch (sortType) {
    case 'sort_a2z':
      return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'accent' })
    case 'sort_z2a':
      return (a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'accent' })
    case 'sort_updated_desc':
      return (a, b) => getTime(b.updatedAt) - getTime(a.updatedAt)
    case 'sort_updated_asc':
      return (a, b) => getTime(a.updatedAt) - getTime(b.updatedAt)
    case 'sort_created_desc':
      return (a, b) => getTime(b.createdAt) - getTime(a.createdAt)
    case 'sort_created_asc':
      return (a, b) => getTime(a.createdAt) - getTime(b.createdAt)
    default:
      return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'accent' })
  }
}

function getTime(value?: string): number {
  return value ? new Date(value).getTime() : 0
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function filterMarkdown(files: File[]): File[] {
  return files.filter((file) => file.name.toLowerCase().endsWith(MARKDOWN_EXT))
}

function collectFolders(files: File[], basePath: string): Set<string> {
  const folders = new Set<string>()

  files.forEach((file) => {
    const relativePath = file.webkitRelativePath || ''
    if (!relativePath.includes('/')) {
      return
    }

    const parts = relativePath.split('/')
    parts.pop()

    let current = basePath
    for (const part of parts) {
      current = `${current}/${part}`
      folders.add(current)
    }
  })

  return folders
}

async function createFolders(folders: Set<string>): Promise<void> {
  const ordered = Array.from(folders).sort((a, b) => a.length - b.length)

  for (const folder of ordered) {
    try {
      await window.api.file.mkdir(folder)
    } catch (error) {
      logger.debug('Skip existing folder while uploading notes', {
        folder,
        error: (error as Error).message
      })
    }
  }
}

function resolveFileTarget(file: File, basePath: string): { dir: string; name: string } {
  if (!file.webkitRelativePath || !file.webkitRelativePath.includes('/')) {
    const nameWithoutExt = file.name.endsWith(MARKDOWN_EXT) ? file.name.slice(0, -MARKDOWN_EXT.length) : file.name
    return { dir: basePath, name: nameWithoutExt }
  }

  const parts = file.webkitRelativePath.split('/')
  const fileName = parts.pop() || file.name
  const dirPath = `${basePath}/${parts.join('/')}`
  const nameWithoutExt = fileName.endsWith(MARKDOWN_EXT) ? fileName.slice(0, -MARKDOWN_EXT.length) : fileName

  return { dir: dirPath, name: nameWithoutExt }
}
