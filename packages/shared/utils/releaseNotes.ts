/**
 * 发布说明的分语切块。
 *
 * 本仓的发布说明（`electron-builder.yml` 的 `releaseInfo.releaseNotes`）用
 * `<!--LANG:en-->` / `<!--LANG:zh-CN-->` / `<!--LANG:END-->` 分段；GitHub Release 的
 * body 则是纯文本，没有标记。渲染层按当前界面语言取段，主进程只转发原文。
 */
const LANG_BLOCK = /<!--LANG:([\w-]+)-->\s*([\s\S]*?)(?=<!--LANG:|<!--LANG:END-->|$)/g

export function sliceReleaseNotes(notes: string | null | undefined, language: string): string | null {
  const text = (notes ?? '').trim()
  if (text.length === 0) return null

  const blocks = new Map<string, string>()
  for (const match of text.matchAll(LANG_BLOCK)) {
    const body = match[2].trim()
    if (body.length > 0) blocks.set(match[1].toLowerCase(), body)
  }
  if (blocks.size === 0) return text

  const want = (language ?? '').toLowerCase()
  const primary = want.split('-')[0]
  // 先精确命中，再按主语言前缀命中（`zh-Hans` → `zh-cn`、`en-US` → `en`），最后退英文。
  const byPrimary = [...blocks.entries()].find(([key]) => key === primary || key.split('-')[0] === primary)
  return blocks.get(want) ?? byPrimary?.[1] ?? blocks.get('en') ?? text
}
