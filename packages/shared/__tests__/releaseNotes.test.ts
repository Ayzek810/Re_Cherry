import { sliceReleaseNotes } from '@shared/utils/releaseNotes'
import { describe, expect, it } from 'vitest'

const MULTI_LANG = `<!--LANG:en-->
Re_Cherry 1.0.0 - something new

- fixed a thing
<!--LANG:zh-CN-->
Re_Cherry 1.0.0 —— 新东西

- 修了一件事
<!--LANG:END-->`

describe('sliceReleaseNotes', () => {
  it('按语言取分语块', () => {
    expect(sliceReleaseNotes(MULTI_LANG, 'zh-CN')).toBe('Re_Cherry 1.0.0 —— 新东西\n\n- 修了一件事')
    expect(sliceReleaseNotes(MULTI_LANG, 'en')).toBe('Re_Cherry 1.0.0 - something new\n\n- fixed a thing')
  })

  it('语言大小写与区域码都能命中', () => {
    expect(sliceReleaseNotes(MULTI_LANG, 'zh-cn')).toContain('新东西')
    expect(sliceReleaseNotes(MULTI_LANG, 'zh-Hans')).toContain('新东西')
  })

  it('没有该语言的块时退到英文', () => {
    expect(sliceReleaseNotes(MULTI_LANG, 'ja')).toContain('something new')
  })

  it('没有语言标记的纯文本原样返回（GitHub Release 的 body 就是这个形态）', () => {
    expect(sliceReleaseNotes('修了几个 bug', 'zh-CN')).toBe('修了几个 bug')
  })

  it('空值与空白返回 null', () => {
    expect(sliceReleaseNotes(null, 'en')).toBeNull()
    expect(sliceReleaseNotes(undefined, 'en')).toBeNull()
    expect(sliceReleaseNotes('   \n  ', 'en')).toBeNull()
  })

  it('空的分语块不算数', () => {
    const notes = `<!--LANG:zh-CN-->

<!--LANG:en-->
only english
<!--LANG:END-->`
    expect(sliceReleaseNotes(notes, 'zh-CN')).toBe('only english')
  })
})
