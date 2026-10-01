/**
 * ExportService 行为测试（v1 二轮审查 m2-16 / m2-17）。
 *
 * m2-16：`link_open` 分支原写 `token.attrs.find(...)[1]` 与 `tokens[i + 1].content`——
 * 自动链接等形态下 attrs 可能为 null、无 href 时 find 返回 undefined，两处都抛 TypeError，
 * 用户点导出什么都得不到。用例断言含自动链接的正文能正常走完导出。
 * m2-17：保存对话框由 `showSaveDialogSync` 改 `await showSaveDialog`；用户取消返回 null
 * （取消不是失败，不抛错），写出成功返回落盘路径。
 *
 * setup 层把 node:path 换成浅 mock（join 退化为字符串拼接），docx 内部依赖真 path，
 * 故本文件先还原真实现（DxtService.test.ts 同款 importOriginal 惯例）。
 */
vi.mock('node:path', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, default: actual }
})

import { app, dialog } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// setup 的 electron mock 没给 app.getLocale，而 ExportService 经 @main/utils/locales 的
// t() → configManager.getLanguage() 会读它
vi.mocked(app).getLocale = vi.fn(() => 'en-US')

const { mockWriteFile } = vi.hoisted(() => ({ mockWriteFile: vi.fn() }))

// FileStorage 的可执行闭包很重（chokidar / pdf-lib / officeparser / word-extractor）。
// 本测试只关心「写出被调用」，故只替换这一个接缝。
vi.mock('../FileStorage', () => ({
  fileStorage: { writeFile: mockWriteFile }
}))

import { ExportService } from '../ExportService'

const mockedDialog = vi.mocked(dialog)

describe('ExportService.exportToWord', () => {
  let service: ExportService

  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
    service = new ExportService()
  })

  it('含自动链接与参考式链接的正文不抛 TypeError（m2-16）', async () => {
    mockedDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/mock/out.docx' })

    const markdown = [
      '普通段落。',
      '',
      '<https://example.com/auto>',
      '',
      '参考式 [文档][ref] 链接。',
      '',
      '[ref]: https://example.com/ref'
    ].join('\n')

    await expect(service.exportToWord({} as Electron.IpcMainInvokeEvent, markdown, 'note')).resolves.toBe(
      '/mock/out.docx'
    )
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockedDialog.showSaveDialog).toHaveBeenCalledTimes(1)
  })

  it('改走异步 showSaveDialog（m2-17）：同步对话框 API 不再被调用', async () => {
    mockedDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/mock/out.docx' })

    await service.exportToWord({} as Electron.IpcMainInvokeEvent, '# 标题', 'note')

    expect(mockedDialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'note', filters: [expect.objectContaining({ extensions: ['docx'] })] })
    )
    expect(mockWriteFile).toHaveBeenCalledWith(expect.anything(), '/mock/out.docx', expect.anything())
  })

  it('用户取消返回 null 且不写盘、不抛错（m2-17 取消语义）', async () => {
    mockedDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })

    await expect(service.exportToWord({} as Electron.IpcMainInvokeEvent, '正文', 'note')).resolves.toBeNull()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('写盘失败如实上抛（失败不伪装成成功）', async () => {
    mockedDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/mock/out.docx' })
    mockWriteFile.mockRejectedValue(new Error('EACCES'))

    await expect(service.exportToWord({} as Electron.IpcMainInvokeEvent, '正文', 'note')).rejects.toThrow('EACCES')
  })
})
