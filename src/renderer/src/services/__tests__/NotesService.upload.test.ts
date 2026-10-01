import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 笔记上传的结果与失败语义。
 *
 * 主进程批量接口对单文件失败只记日志、把它排除在 `fileCount` 之外并**照常成功返回**；
 * 旧实现把这个差额丢掉，用户在任何情况下都只看到"上传成功"。这里钉三件事：
 *   ① 差额必须作为 `failedFiles` 回传并弹可见提示（"N 成功 / M 失败"）；
 *   ② 兼容路径只在 `file.path` 缺失或批量接口**整体**失败时启用，并留下 `usedLegacyPath`；
 *   ③ 全部成功、空输入、无有效 markdown 的边界不误报失败。
 */

const batchUploadMarkdown = vi.hoisted(() => vi.fn())
const pauseFileWatcher = vi.hoisted(() => vi.fn())
const resumeFileWatcher = vi.hoisted(() => vi.fn())
const checkFileName = vi.hoisted(() => vi.fn())
const writeFile = vi.hoisted(() => vi.fn())
const mkdir = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
const setNotesPath = vi.hoisted(() => vi.fn((payload: unknown) => ({ type: 'note/setNotesPath', payload })))

vi.mock('@renderer/store', () => ({ default: { dispatch: vi.fn() } }))
vi.mock('@renderer/store/note', () => ({ setNotesPath }))
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import { uploadNotes } from '../NotesService'

// jsdom 的 Blob 没有 `text()`（真机 Chromium 有）：兼容路径要读文件正文，这里补上。
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function text(this: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}

/** 带原生 `path` 的 File 形状（目录上传时 Electron 会附上）。 */
function nativeFile(name: string, path: string, content = '# hi'): File {
  const file = new File([content], name, { type: 'text/markdown' })
  Object.defineProperty(file, 'path', { value: path })
  return file
}

/** 浏览器 File（无 `path`）→ 只能走兼容路径。 */
function browserFile(name: string): File {
  return new File(['# hi'], name, { type: 'text/markdown' })
}

beforeEach(() => {
  batchUploadMarkdown.mockReset()
  pauseFileWatcher.mockReset().mockResolvedValue(undefined)
  resumeFileWatcher.mockReset().mockResolvedValue(undefined)
  checkFileName.mockReset().mockResolvedValue({ safeName: 'note', exists: false })
  writeFile.mockReset().mockResolvedValue(undefined)
  mkdir.mockReset().mockResolvedValue(undefined)
  toastWarning.mockReset()

  vi.stubGlobal('window', {
    ...globalThis.window,
    api: {
      file: {
        batchUploadMarkdown,
        pauseFileWatcher,
        resumeFileWatcher,
        checkFileName,
        write: writeFile,
        mkdir
      }
    },
    toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() }
  })
})

describe('uploadNotes', () => {
  it('批量路径部分失败 → failedFiles 报出差额并弹可见信号', async () => {
    // 3 个 md 里主进程只写成功 1 个、跳过 1 个 → 失败 1 个
    batchUploadMarkdown.mockResolvedValue({ fileCount: 1, folderCount: 0, skippedFiles: 1 })

    const result = await uploadNotes(
      [nativeFile('a.md', 'C:/in/a.md'), nativeFile('b.md', 'C:/in/b.md'), nativeFile('c.txt', 'C:/in/c.txt')],
      'C:/notes'
    )

    expect(result.fileCount).toBe(1)
    expect(result.failedFiles).toBe(1)
    expect(result.usedLegacyPath).toBe(false)
    expect(toastWarning).toHaveBeenCalledTimes(1)
    // 旧实现只返回 fileCount=1，页面渲染"上传成功"，这条差额无人知晓。
    expect(batchUploadMarkdown).toHaveBeenCalledTimes(1)
  })

  it('批量路径全部成功 → failedFiles=0，不弹提示', async () => {
    batchUploadMarkdown.mockResolvedValue({ fileCount: 2, folderCount: 0, skippedFiles: 0 })

    const result = await uploadNotes([nativeFile('a.md', 'C:/in/a.md'), nativeFile('b.md', 'C:/in/b.md')], 'C:/notes')

    expect(result).toMatchObject({ fileCount: 2, failedFiles: 0, usedLegacyPath: false })
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('批量接口整体失败 → 走兼容路径并标记 usedLegacyPath + 提示', async () => {
    batchUploadMarkdown.mockRejectedValue(new Error('mkdir failed'))
    checkFileName.mockResolvedValue({ safeName: 'a', exists: false })

    const result = await uploadNotes([nativeFile('a.md', 'C:/in/a.md')], 'C:/notes')

    expect(result.usedLegacyPath).toBe(true)
    expect(result.fileCount).toBe(1)
    expect(result.failedFiles).toBe(0)
    expect(writeFile).toHaveBeenCalledWith('C:/notes/a.md', '# hi')
    expect(toastWarning).toHaveBeenCalledTimes(1)
    // 暂停的 watcher 必须在 finally 里恢复
    expect(resumeFileWatcher).toHaveBeenCalledTimes(1)
  })

  it('文件没有原生 path → 直接走兼容路径（不调批量接口）', async () => {
    checkFileName.mockResolvedValue({ safeName: 'a', exists: false })

    const result = await uploadNotes([browserFile('a.md')], 'C:/notes')

    expect(batchUploadMarkdown).not.toHaveBeenCalled()
    expect(result.usedLegacyPath).toBe(true)
  })

  it('空输入 → 全 0，不触碰任何 IPC', async () => {
    const result = await uploadNotes([], 'C:/notes')

    expect(result).toMatchObject({ totalFiles: 0, fileCount: 0, failedFiles: 0, usedLegacyPath: false })
    expect(pauseFileWatcher).not.toHaveBeenCalled()
    expect(batchUploadMarkdown).not.toHaveBeenCalled()
  })
})
