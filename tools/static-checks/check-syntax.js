/**
 * check-syntax —— 每个 .ts 都能被解析（语法级，不是类型级）。
 *
 * 手段：Node 内置 `module.stripTypeScriptTypes`（amaro）。先用 `strip` 模式；若失败且原因是
 * "strip-only 不支持该构造"（enum / namespace / 参数属性 / 装饰器 等需要降级的特性），
 * 再用 `transform` 模式复检——两者都过才算过，都失败才是真语法错。
 * 这样不会把合法 TS 误报成语法错误。
 *
 * `.tsx` **不在覆盖范围内**：Node 的剥离器不支持 JSX，本检查如实记账（skipped），不假装通过。
 */
'use strict'

// 只压掉对 stripTypeScriptTypes 的 ExperimentalWarning（否则每次跑套件都在 stderr 上留噪音，
// 让 CI/调用方把"有 stderr"误读成失败）。其他警告照常放行。
const originalEmitWarning = process.emitWarning
process.emitWarning = function emitWarningFiltered(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
  if (/stripTypeScriptTypes/i.test(text)) return
  return originalEmitWarning.call(process, warning, ...rest)
}

const { stripTypeScriptTypes } = require('node:module')

const C = require('./lib/common')

/** 该失败是否只是"strip 模式不支持"而非真语法错。 */
function isStripOnlyLimitation(message) {
  return /strip-only mode|not supported in strip-only|TypeScript enum|namespace|parameter propert|decorator/i.test(
    message
  )
}

function checkFile(abs) {
  const source = C.readText(abs)
  try {
    stripTypeScriptTypes(source, { mode: 'strip' })
    return { ok: true, mode: 'strip' }
  } catch (stripError) {
    if (!isStripOnlyLimitation(stripError.message)) {
      return { ok: false, detail: `strip 解析失败: ${stripError.message}` }
    }
    try {
      stripTypeScriptTypes(source, { mode: 'transform' })
      return { ok: true, mode: 'transform' }
    } catch (transformError) {
      return { ok: false, detail: `transform 解析也失败: ${transformError.message}` }
    }
  }
}

function run() {
  const report = C.createReport('check-syntax')
  const all = C.walkSources()
  const tsFiles = all.filter((f) => /\.(ts|mts|cts)$/.test(f))
  const tsxFiles = all.filter((f) => f.endsWith('.tsx'))
  const jsFiles = all.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f))
  let stripCount = 0
  let transformCount = 0

  for (const file of tsFiles) {
    const result = checkFile(file)
    if (result.ok) {
      if (result.mode === 'transform') transformCount += 1
      else stripCount += 1
    } else {
      report.fail(`${C.rel(file)} ${result.detail}`)
    }
  }

  report.note(
    `解析 ${tsFiles.length} 个 .ts（strip ${stripCount} / transform 兜底 ${transformCount}）；` +
      `.tsx ${tsxFiles.length} 个与 .js/.mjs/.cjs ${jsFiles.length} 个不在覆盖范围` +
      `（Node 剥离器不支持 JSX，本检查如实记账、不假装通过）`
  )
  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
