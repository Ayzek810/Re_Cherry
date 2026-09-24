/**
 * 聊天页生成图登记进文件仓（v0.3.3-2，用户点名："聊天页的绘图同样没有被算进去"）。
 *
 * 钉住两件事：① id 是**源串 sha256**（同图同 id ⇒ 回放重投影不会堆积文件）；
 * ② 行已存在时**不再调用落盘 IPC**（这是"不堆积"的实际保证）。
 */
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows = new Map<string, FileMetadata>()
const saveGeneratedImage = vi.fn(async ({ id, source }: { id: string; source: string }): Promise<FileMetadata> => {
  const file: FileMetadata = {
    id,
    name: `${id}.png`,
    origin_name: `生成图片-${id.slice(0, 8)}.png`,
    path: `F:/Documents/Re_Cherry/Data/Files/${id}.png`,
    size: source.length,
    ext: '.png',
    type: FILE_TYPE.IMAGE,
    created_at: '2026-09-24T00:00:00.000Z',
    count: 1
  }
  return file
})

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      get: async (id: string) => rows.get(id),
      put: async (file: FileMetadata) => {
        rows.set(file.id, file)
      }
    }
  }
}))

vi.stubGlobal('window', { api: { file: { saveGeneratedImage } } })

const { generatedImageFileId, registerGeneratedImageFiles } = await import('../kernelImages')

describe('generatedImageFileId', () => {
  it('同一源串稳定同 id（64 位十六进制），不同源串不同 id', async () => {
    const a = await generatedImageFileId('data:image/png;base64,aGVsbG8=')
    const b = await generatedImageFileId('data:image/png;base64,aGVsbG8=')
    const c = await generatedImageFileId('https://cdn.example.com/x.png')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('registerGeneratedImageFiles', () => {
  beforeEach(() => {
    rows.clear()
    saveGeneratedImage.mockClear()
  })

  it('首次登记：落盘 + 入 files 行（type=image）', async () => {
    const [file] = await registerGeneratedImageFiles(['data:image/png;base64,aGVsbG8='])
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1)
    expect(file?.type).toBe(FILE_TYPE.IMAGE)
    expect(rows.size).toBe(1)
    expect(rows.get(file!.id)).toEqual(file)
  })

  it('重复投影（回放/重开话题）：命中同 id 直接跳过，不再落盘、不再新增行', async () => {
    const images = ['data:image/png;base64,aGVsbG8=']
    await registerGeneratedImageFiles(images)
    saveGeneratedImage.mockClear()

    const again = await registerGeneratedImageFiles(images)

    expect(again).toHaveLength(1)
    expect(saveGeneratedImage).not.toHaveBeenCalled()
    expect(rows.size).toBe(1)
  })

  it('单张失败不影响其余（生成图已能在会话里看到，登记只是可发现性增强）', async () => {
    saveGeneratedImage.mockRejectedValueOnce(new Error('HTTP 500'))
    const registered = await registerGeneratedImageFiles([
      'https://cdn.example.com/a.png',
      'data:image/png;base64,aGVsbG8='
    ])
    expect(registered).toHaveLength(1)
    expect(rows.size).toBe(1)
  })
})
