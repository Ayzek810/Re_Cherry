// 本文件测试 HTML 产物预览请求白名单：允许 data/blob/http(s)/ws(s)，拦截本地、私有与非法协议。

import { describe, expect, it } from 'vitest'

import { isAllowedHtmlArtifactRequest } from '../htmlArtifactRequest'

describe('isAllowedHtmlArtifactRequest', () => {
  it.each([
    'data:text/html,<h1>Preview</h1>',
    'blob:https://example.com/preview',
    'https://example.com/style.css',
    'wss://example.com/socket'
  ])('allows artifact preview resources from %s', (url) => {
    expect(isAllowedHtmlArtifactRequest(url)).toBe(true)
  })

  it.each([
    'file:///etc/passwd',
    'http://127.0.0.1/private',
    'ws://localhost/socket',
    'javascript:alert(1)',
    'not-a-url'
  ])('blocks unsafe artifact preview resources from %s', (url) => {
    expect(isAllowedHtmlArtifactRequest(url)).toBe(false)
  })
})
