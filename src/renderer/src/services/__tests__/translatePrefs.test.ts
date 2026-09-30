import settingsReducer, { setTranslatePreferences } from '@renderer/store/settings'
import { determineTargetLanguage, validateCustomLanguage } from '@renderer/utils/translate'
import { describe, expect, it } from 'vitest'

/**
 * 翻译页偏好项回补（v0.4.7）单测：
 *   ① 自定义语言校验（空名/空码/内置码/重复码/正常）；
 *   ② determineTargetLanguage 放宽后：自定义码直通、内置配对语义不变；
 *   ③ 翻译偏好 action 的合并语义（Partial 覆盖，未提及字段不动）。
 */
const BUILTIN = new Set(['zh-cn', 'en-us', 'ja-jp'])

describe('validateCustomLanguage', () => {
  const existing = [{ langCode: 'xx-xx' }]

  it('正常新增（码小写化、名去空白）', () => {
    expect(validateCustomLanguage(' Klingon ', ' TLH ', BUILTIN, [])).toEqual({
      ok: true,
      value: 'Klingon',
      langCode: 'tlh'
    })
  })

  it('空名 / 空码 → 失败', () => {
    expect(validateCustomLanguage('  ', 'tlh', BUILTIN, []).ok).toBe(false)
    expect(validateCustomLanguage('Klingon', '  ', BUILTIN, []).ok).toBe(false)
  })

  it('内置码 / 已存在码 → 失败', () => {
    expect(validateCustomLanguage('中文', 'zh-cn', BUILTIN, []).ok).toBe(false)
    expect(validateCustomLanguage('Klingon', 'xx-xx', BUILTIN, existing).ok).toBe(false)
  })
})

describe('determineTargetLanguage（AnyTranslateLangCode 放宽）', () => {
  it('自定义码直通（无内置配对语义）', () => {
    expect(determineTargetLanguage('en-us', 'tlh')).toEqual({ ok: true, source: 'en-us', target: 'tlh' })
    expect(determineTargetLanguage('auto', 'tlh')).toEqual({ ok: true, source: 'auto', target: 'tlh' })
  })

  it('内置配对语义不变：同语言拒绝、auto 保持 auto（v0.3.3 既有语义，对向解析留给模型）', () => {
    expect(determineTargetLanguage('zh-cn', 'zh-cn')).toEqual({ ok: false, reason: 'same_language' })
    expect(determineTargetLanguage('auto', 'zh-cn')).toEqual({ ok: true, source: 'auto', target: 'zh-cn' })
  })
})

describe('翻译偏好 action 合并语义', () => {
  it('Partial 合并：只覆盖提及字段，未提及字段不动', () => {
    let state = settingsReducer(undefined, { type: '@@init' })
    expect(state.translateAutoCopy).toBe(false)
    expect(state.translateCustomLanguages).toEqual([])

    state = settingsReducer(state, setTranslatePreferences({ translateAutoCopy: true }))
    expect(state.translateAutoCopy).toBe(true)
    expect(state.translateCustomPrompt).toBe('')
    expect(state.translateCustomLanguages).toEqual([])

    const langs = [{ langCode: 'tlh', value: 'Klingon', emoji: '🌐' }]
    state = settingsReducer(state, setTranslatePreferences({ translateCustomLanguages: langs }))
    expect(state.translateAutoCopy).toBe(true)
    expect(state.translateCustomLanguages).toEqual(langs)
  })
})
