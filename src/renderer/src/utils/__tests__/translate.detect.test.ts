/**
 * 离线语言检测（V1 `utils/translate.ts:103-129` 的 franc 档）：用真实 `franc-min`，
 * 断言"真实输入 → 承诺的语言码"，不打桩。检测不出必须返回 null（调用方保留"自动检测"占位）。
 */
import { detectLanguage } from '@renderer/utils/translate'
import { describe, expect, it } from 'vitest'

describe('detectLanguage（V1 franc 档）', () => {
  it('中文/英文/日文/俄文样本映射到 fork 语言码', () => {
    expect(detectLanguage('这是一段足够长的中文文本，用来让语言检测有足够的样本可以判断。')).toBe('zh-cn')
    expect(detectLanguage('This is a long enough English sentence for the language detector to work reliably.')).toBe(
      'en-us'
    )
    expect(detectLanguage('これは言語検出のために十分に長い日本語の文章です。')).toBe('ja-jp')
    expect(detectLanguage('Это достаточно длинное предложение на русском языке для определения языка.')).toBe('ru-ru')
  })

  it('空串与纯空白返回 null（不猜语言）', () => {
    expect(detectLanguage('')).toBeNull()
    expect(detectLanguage('   \n\t ')).toBeNull()
  })

  it('检测不出时返回 null，而不是回落成某个具体语言', () => {
    // 单字符/符号没有可判定的语言特征：franc 返回 und，映射不到即 null
    expect(detectLanguage('。')).toBeNull()
    expect(detectLanguage('1234567890')).toBeNull()
  })
})
