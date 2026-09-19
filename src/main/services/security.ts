/**
 * Security utility functions for the main process.
 */

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'obsidian:',
  'vscode:',
  'vscode-insiders:',
  'cursor:',
  'zed:'
])

/**
 * Editor deep-link schemes. For these we only accept the "open a file" shape
 * produced by `buildEditorUrl()`, so that attacker-supplied links cannot
 * reach other authorities such as `vscode://command/...` (runs registered
 * commands) or `vscode://<publisher>.<extension>/...` (invokes extension URL
 * handlers).
 */
const EDITOR_DEEP_LINK_PROTOCOLS = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'zed:'])

/**
 * Zed's deep-link format is `zed://file<path>` (no slash separator before
 * the path — Zed strips the `zed://file` prefix and treats the rest as a
 * filesystem path). That means on Unix the URL is `zed://file/abs/path`
 * (host parses as `file`), but on Windows it is `zed://fileC%3A/abs/path`
 * (host parses as `fileC%3A`), so a plain `host === 'file'` check is
 * insufficient. Match the two exact shapes buildEditorUrl() can emit: a
 * slash, or a single-letter encoded drive followed by a slash.
 */
const ZED_FILE_URL_RE = /^zed:\/\/file(\/|[A-Za-z]%3[Aa]\/)/i

/**
 * Check whether a URL is safe to open via shell.openExternal().
 *
 * Only an explicit allowlist of schemes is permitted (web links, mail, and
 * known code-editor deep-links used by the app). Editor schemes are further
 * restricted to the "open a file" URL shape emitted by `buildEditorUrl()` so
 * that attackers cannot smuggle in `vscode://command/...` command URIs,
 * extension URL handlers, or userinfo tricks like `zed://file@evil/...`.
 *
 * @see https://benjamin-altpeter.de/shell-openexternal-dangers/
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return false
    }
    if (EDITOR_DEEP_LINK_PROTOCOLS.has(parsed.protocol)) {
      return isFileOpenEditorUrl(parsed, url)
    }
    return true
  } catch {
    return false
  }
}

/**
 * v0.3.1-2：判断一次导航/开窗目标是否属于**应用自身源**。
 *
 * 事故：`WindowService` 的 `will-navigate` 里，自身源豁免被硬编码为上游的 `localhost:517`，
 * 而本 fork 的 dev 服务器端口是 `DSH_DEV_PORT || 5870`——豁免永不命中，于是 dev 下任何
 * 「整页导航到应用自己」都被 `preventDefault()` 拦下并 `shell.openExternal()` 丢进系统浏览器
 * （用户实测：浏览器被拉起 `http://localhost:5870` 与 `…/miniWindow.html`）。
 *
 * 改为**与当前窗口自身 URL 的 origin 比对**：与端口、与 dev/生产无关，主窗口与 mini 窗口
 * 各自都成立。origin 为 `null`（`about:blank`/部分 `file:`）或解析失败时一律判否，
 * 避免"双方都空"被误判为同源而放行任意导航。
 */
export function isSelfOriginNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const target = new URL(targetUrl)
    if (!target.origin || target.origin === 'null') {
      return false
    }
    const own = new URL(currentUrl)
    if (!own.origin || own.origin === 'null') {
      return false
    }
    return target.origin === own.origin
  } catch {
    return false
  }
}

function isFileOpenEditorUrl(parsed: URL, rawUrl: string): boolean {
  // Reject userinfo in any form to foil `zed://file@evil/path`-style tricks
  // where "file" ends up as the username and the real host is attacker-chosen.
  if (parsed.username !== '' || parsed.password !== '') {
    return false
  }
  if (parsed.protocol === 'zed:') {
    return ZED_FILE_URL_RE.test(rawUrl)
  }
  // vscode / vscode-insiders / cursor all produce <scheme>://file/<path>,
  // where the URL authority is exactly "file".
  return parsed.host === 'file'
}
