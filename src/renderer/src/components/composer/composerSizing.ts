// fork 缝：V2 `components/composer/composerSizing.ts` 逐字搬运。
export function getComposerEditorMinHeight(fontSize: number) {
  return Math.ceil(fontSize * 1.4 * 2 + 6)
}

export function getCompactComposerEditorMinHeight(fontSize: number) {
  return Math.ceil(fontSize * 1.4 + 6)
}
