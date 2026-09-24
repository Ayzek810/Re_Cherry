/**
 * 下载落盘的文件名/后缀解析（v0.3.3-2 修"AI 生成的图片没被文件页纳入"）。
 *
 * 现场：`downloadFile(url, true)` 原先无条件把 Content-Type 推出的后缀**追加**到文件名尾部——
 * URL 已带 `.png`、响应头是 `application/octet-stream`（→ `.bin`）时落成 `xxx.png.bin`、`ext=.bin`、
 * `FILE_TYPE.OTHER`，文件页「图片」分类里看不到这张图。这里钉住四条口径（真机取证见报告 §1）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/userData') }
}))
vi.mock('uuid', () => ({ v4: () => 'mock-uuid' }))

import { resolveDownloadedFileName } from '../file'

describe('resolveDownloadedFileName', () => {
  it('文件名已有后缀 + Content-Type 未知（.bin）→ 保留原后缀（不再叠加成 .png.bin）', () => {
    expect(resolveDownloadedFileName('ComfyUI_00001_.png', '.bin', true)).toEqual({
      fileName: 'ComfyUI_00001_.png',
      ext: '.png'
    })
  })

  it('文件名已有后缀 + Content-Type 确定 → 以响应头为准（替换而非追加）', () => {
    expect(resolveDownloadedFileName('image.png', '.jpg', true)).toEqual({
      fileName: 'image.jpg',
      ext: '.jpg'
    })
  })

  it('文件名无后缀 → 用 Content-Type 后缀；未知则退回 .bin（与旧行为一致）', () => {
    expect(resolveDownloadedFileName('download', '.webp', true)).toEqual({
      fileName: 'download.webp',
      ext: '.webp'
    })
    expect(resolveDownloadedFileName('download', '.bin', false)).toEqual({
      fileName: 'download.bin',
      ext: '.bin'
    })
  })

  it('preferContentType=false：有后缀就一律保留（不读响应头那一路的语义）', () => {
    expect(resolveDownloadedFileName('report.pdf', '.bin', false)).toEqual({
      fileName: 'report.pdf',
      ext: '.pdf'
    })
  })

  it('边界：目录名里的点不算后缀，前导点文件不算后缀，大小写归一', () => {
    expect(resolveDownloadedFileName('a.b/name', '.png', true)).toEqual({ fileName: 'a.b/name.png', ext: '.png' })
    expect(resolveDownloadedFileName('.gitignore', '.bin', true)).toEqual({ fileName: '.gitignore.bin', ext: '.bin' })
    expect(resolveDownloadedFileName('IMAGE.PNG', '.bin', true)).toEqual({ fileName: 'IMAGE.PNG', ext: '.PNG' })
  })
})
