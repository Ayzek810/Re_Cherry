/* eslint-disable @eslint-react/dom/no-missing-iframe-sandbox -- sandbox is always supplied via the (defaulted) prop; the rule can't statically resolve the dynamic value. */
import { Parser } from 'htmlparser2'
import { memo, type Ref } from 'react'

export const HTML_PREVIEW_DEFAULT_BASE_URL = 'about:srcdoc'

// Fully-restricted sandbox: an empty `sandbox` applies every restriction — no scripts, no forms,
// opaque origin — while still rendering static HTML/CSS, and it is the **default** here because
// the fork (v0.3.3) removed HTML-artifact screenshot capture: nothing needs `allow-same-origin`
// any more, so the permissive value must not be reachable by omission.
// Running NO scripts is the deliberate choice: the main window sets `webSecurity: false`
// (WindowService.ts), which disables the same-origin policy, so merely dropping
// `allow-same-origin` is NOT a reliable boundary — a script in an opaque-origin iframe could
// still reach `parent.api` and the file bridge to read/exfiltrate arbitrary local files.
// Interactive documents that genuinely need scripts go through the consent-gated,
// dedicated-partition webview instead (see InteractiveHtmlPreview). Pair with
// {@link HTML_PREVIEW_RESTRICTED_CSP}.
export const HTML_PREVIEW_RESTRICTED_SANDBOX = ''

// Strict CSP for untrusted local-file previews, injected as a `<meta http-equiv>` tag.
// `default-src 'none'` blocks scripts and every network connection; only passive local
// resources (data/blob/file) are allowed, so a preview cannot phone home or exfiltrate
// content even though the frame is already script-less. Defense-in-depth behind the sandbox.
export const HTML_PREVIEW_RESTRICTED_CSP =
  "default-src 'none'; img-src data: blob: file:; media-src data: blob: file:; style-src 'unsafe-inline' file:; font-src data: file:"

interface HtmlPreviewFrameProps {
  html: string
  title: string
  baseUrl?: string
  emptyText?: string
  /** iframe `sandbox` value. Defaults to the fully restricted (script-less) sandbox;
   *  interactive documents needing scripts go through the consent-gated webview instead. */
  sandbox?: string
  /** Content-Security-Policy injected as a `<meta http-equiv>` tag. Pass
   *  {@link HTML_PREVIEW_RESTRICTED_CSP} for untrusted files; omit for trusted artifacts. */
  csp?: string
  iframeRef?: Ref<HTMLIFrameElement>
}

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const LEADING_DOCUMENT_PREAMBLE_REGEX =
  /^(?:\s*(?:<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[\s\S]*?\?>))*\s*(?:<html(?:\s[^>]*)?>\s*(?:<!--[\s\S]*?-->\s*)*)?/i

function hasHtmlElement(html: string, elementName: string): boolean {
  let found = false
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === elementName) found = true
      }
    },
    { lowerCaseTags: true }
  )
  parser.end(html)
  return found
}

export function injectHtmlPreviewHeadElement(html: string, element: string): string {
  const preambleEnd = html.match(LEADING_DOCUMENT_PREAMBLE_REGEX)?.[0].length ?? 0
  const remainder = html.slice(preambleEnd)
  const headMatch = remainder.match(/^<head(?:\s[^>]*)?>/i)
  if (headMatch?.index !== undefined) {
    const insertAt = preambleEnd + headMatch[0].length
    return `${html.slice(0, insertAt)}${element}${html.slice(insertAt)}`
  }

  return `${html.slice(0, preambleEnd)}<head>${element}</head>${html.slice(preambleEnd)}`
}

export function injectHtmlPreviewBase(html: string, baseUrl = HTML_PREVIEW_DEFAULT_BASE_URL): string {
  if (!html.trim() || hasHtmlElement(html, 'base')) return html
  return injectHtmlPreviewHeadElement(html, `<base href="${escapeHtmlAttribute(baseUrl)}">`)
}

export function injectHtmlPreviewCsp(html: string, csp: string): string {
  if (!html.trim()) return html
  return injectHtmlPreviewHeadElement(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`
  )
}

export const HtmlPreviewFrame = memo<HtmlPreviewFrameProps>(
  ({
    html,
    title,
    baseUrl = HTML_PREVIEW_DEFAULT_BASE_URL,
    emptyText,
    sandbox = HTML_PREVIEW_RESTRICTED_SANDBOX,
    csp,
    iframeRef
  }) => {
    const withBase = injectHtmlPreviewBase(html, baseUrl)
    const srcDoc = csp ? injectHtmlPreviewCsp(withBase, csp) : withBase
    return (
      <div className="h-full w-full overflow-hidden bg-white">
        {html.trim() ? (
          <iframe
            ref={iframeRef}
            srcDoc={srcDoc}
            title={title}
            sandbox={sandbox}
            className="h-full w-full border-0 bg-white"
          />
        ) : emptyText ? (
          <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground text-sm">
            <p>{emptyText}</p>
          </div>
        ) : null}
      </div>
    )
  }
)

export default HtmlPreviewFrame
