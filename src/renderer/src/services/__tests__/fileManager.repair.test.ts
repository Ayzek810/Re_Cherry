/**
 * 历史文件行修复（v0.3.3-2）：`downloadFile` 曾把 Content-Type 后缀追加到已有后缀之后，
 * 落成 `xxx.png.bin` / `ext=.bin` / `type=other` —— 文件页「图片」分类里看不到 AI 生成的图。
 * 这里钉住纯函数的判定：只认"`.bin` + origin_name 尾部这个多余后缀 + 去后缀后是已知类型"三合一。
 */
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { repairLegacyDownloadedFile } from '../FileManager'

const base: FileMetadata = {
  id: 'caf9cc30-069e-4bdc-a93b-93f77a681643',
  name: 'caf9cc30-069e-4bdc-a93b-93f77a681643.bin',
  origin_name: 'Ufti_ComfyUI_b8776b2f_00001_.png.bin',
  path: 'F:/Documents/Re_Cherry/Data/Files/caf9cc30-069e-4bdc-a93b-93f77a681643.bin',
  size: 1095307,
  ext: '.bin',
  type: FILE_TYPE.OTHER,
  created_at: '2026-09-23T14:08:00.143Z',
  count: 1
}

describe('repairLegacyDownloadedFile', () => {
  it('图片：去多余后缀 → type 改 image，ext/name/path 一律不动（盘上文件名就是 <id>.bin）', () => {
    const repaired = repairLegacyDownloadedFile(base)

    expect(repaired).not.toBeNull()
    expect(repaired?.origin_name).toBe('Ufti_ComfyUI_b8776b2f_00001_.png')
    expect(repaired?.type).toBe(FILE_TYPE.IMAGE)
    expect(repaired?.ext).toBe('.bin')
    expect(repaired?.name).toBe(base.name)
    expect(repaired?.path).toBe(base.path)
  })

  it('文档：同一缺陷作用在 pdf 上 → type 改 document', () => {
    const repaired = repairLegacyDownloadedFile({ ...base, origin_name: '报告.pdf.bin' })
    expect(repaired?.type).toBe(FILE_TYPE.DOCUMENT)
    expect(repaired?.origin_name).toBe('报告.pdf')
  })

  it('无需修复的一律返回 null：ext 不是 .bin / origin_name 没有多余后缀 / 去后缀后类型未知', () => {
    expect(repairLegacyDownloadedFile({ ...base, ext: '.png', origin_name: 'a.png' })).toBeNull()
    expect(repairLegacyDownloadedFile({ ...base, origin_name: 'data.bin' })).toBeNull()
    expect(repairLegacyDownloadedFile({ ...base, origin_name: 'weird.zzz.bin' })).toBeNull()
  })

  it('坏行不炸（缺字段/类型不对 → null）', () => {
    expect(repairLegacyDownloadedFile({ ...base, origin_name: undefined as unknown as string })).toBeNull()
    expect(repairLegacyDownloadedFile({ ...base, ext: undefined as unknown as string })).toBeNull()
  })
})
