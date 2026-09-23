// 本文件判定 HTML 产物预览请求的 URL 是否允许，复用远程 URL 字面量安全守卫完成校验。

import { sanitizeRemoteUrl } from './remoteUrlSafety'

export function isAllowedHtmlArtifactRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true

    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
    }

    sanitizeRemoteUrl(url.toString())
    return true
  } catch {
    return false
  }
}
