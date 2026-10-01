/**
 * check-symbols —— 每个 `import { a, b as c } from '<本地路径>'` 里的名字都必须在目标文件里真的导出。
 *
 * 目标文件的导出名用正则收集，覆盖本仓的三种导出形状：
 *   export const X / export function X / export interface X / export type X …
 *   export const { a, b } = slice.actions        （Redux slice 惯用法）
 *   export { default as X, type Y } from './z'
 * 并跟随 `export * from` / `export { } from` 递归解析（带 visited 防环）。
 */
'use strict'

const C = require('./lib/common')

/** 目标必须是本仓的 TypeScript 源文件才做符号校验（JS/CJS 目标跳过）。 */
function isTsTarget(target) {
  return typeof target === 'string' && /\.(ts|tsx|mts|cts)$/.test(target)
}

function run() {
  const report = C.createReport('check-symbols')
  const tables = C.aliasTables()
  const files = C.walkSources()
  const exportCache = new Map()
  let checked = 0
  let skipped = 0
  let typeOnly = 0

  for (const file of files) {
    let code
    try {
      code = C.readText(file)
    } catch {
      continue
    }
    for (const item of C.extractNamedImports(code)) {
      const resolved = C.resolveSpecifier(file, item.spec, tables)
      // 解析失败归 check-imports 报，这里不重复
      if (!resolved.ok || !resolved.target) continue
      if (!isTsTarget(resolved.target)) {
        skipped += 1
        continue
      }
      checked += 1
      const exported = C.resolveExports(resolved.target, tables, exportCache)
      if (!exported.names.has(item.imported)) {
        report.fail(`${C.rel(file)}:${item.line} 导入的 { ${item.imported} } 在 ${C.rel(resolved.target)} 里没有导出`)
      }
      if (item.typeOnly) typeOnly += 1
    }
  }

  report.note(`校验 ${checked} 个具名导入（其中 type-only ${typeOnly}；跳过 ${skipped} 个非 TS 目标）`)
  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
