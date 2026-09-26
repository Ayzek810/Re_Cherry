import { describe, expect, it } from 'vitest'

import { parseDataUrl } from '../utils'

describe('parseDataUrl', () => {
  it('parses a standard base64 image data URL', () => {
    const result = parseDataUrl('data:image/png;base64,iVBORw0KGgo=')
    expect(result).toEqual({
      mediaType: 'image/png',
      isBase64: true,
      data: 'iVBORw0KGgo='
    })
  })

  it('parses a base64 data URL with additional parameters', () => {
    const result = parseDataUrl('data:image/jpeg;name=foo;base64,/9j/4AAQ')
    expect(result).toEqual({
      mediaType: 'image/jpeg',
      isBase64: true,
      data: '/9j/4AAQ'
    })
  })

  it('parses a plain text data URL (non-base64)', () => {
    const result = parseDataUrl('data:text/plain,Hello%20World')
    expect(result).toEqual({
      mediaType: 'text/plain',
      isBase64: false,
      data: 'Hello%20World'
    })
  })

  it('parses a data URL with empty media type', () => {
    const result = parseDataUrl('data:;base64,SGVsbG8=')
    expect(result).toEqual({
      mediaType: undefined,
      isBase64: true,
      data: 'SGVsbG8='
    })
  })

  it('returns null for non-data URLs', () => {
    const result = parseDataUrl('https://example.com/image.png')
    expect(result).toBeNull()
  })

  it('returns null for malformed data URL without comma', () => {
    const result = parseDataUrl('data:image/png;base64')
    expect(result).toBeNull()
  })

  it('handles empty string', () => {
    const result = parseDataUrl('')
    expect(result).toBeNull()
  })

  it('handles large base64 data without performance issues', () => {
    // Simulate a 4K image base64 string (about 1MB)
    const largeData = 'A'.repeat(1024 * 1024)
    const dataUrl = `data:image/png;base64,${largeData}`

    const start = performance.now()
    const result = parseDataUrl(dataUrl)
    const duration = performance.now() - start

    expect(result).not.toBeNull()
    expect(result?.mediaType).toBe('image/png')
    expect(result?.isBase64).toBe(true)
    expect(result?.data).toBe(largeData)
    // Should complete in under 10ms (string operations are fast).
    // 2026-09-24 放宽 10→100ms（§4.12：墙钟是弱信号，不是把慢当绿——该断言的意图是
    // "无病理性慢化"，10 倍量级回归会是秒级；10ms 在全量套件并行负载下会假红，
    // 实测 11.02ms flake 一次，隔离跑恒 6ms）。
    expect(duration).toBeLessThan(100)
  })

  it('parses SVG data URL', () => {
    const result = parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=')
    expect(result).toEqual({
      mediaType: 'image/svg+xml',
      isBase64: true,
      data: 'PHN2Zz4='
    })
  })

  it('parses JSON data URL', () => {
    const result = parseDataUrl('data:application/json,{"key":"value"}')
    expect(result).toEqual({
      mediaType: 'application/json',
      isBase64: false,
      data: '{"key":"value"}'
    })
  })
})
