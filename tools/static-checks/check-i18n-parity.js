/**
 * check-i18n-parity —— en-us 与 zh-cn 的**叶子键集合**必须完全一致。
 *
 * 为什么在 node_modules / pnpm 不可用时仍然要它：它是"两语对称"这条纪律的唯一机器防线，
 * 而 `pnpm i18n:check` 需要依赖树。此检查只用 fs + JSON。
 */
'use strict'

const C = require('./lib/common')

function run() {
  const report = C.createReport('check-i18n-parity')
  const en = C.leafKeys(C.localeBundle('en-us'))
  const zh = C.leafKeys(C.localeBundle('zh-cn'))

  const missingInZh = [...en].filter((k) => !zh.has(k)).sort()
  const missingInEn = [...zh].filter((k) => !en.has(k)).sort()

  for (const k of missingInZh) report.fail(`zh-cn 缺少键: ${k}`)
  for (const k of missingInEn) report.fail(`en-us 缺少键: ${k}`)
  report.note(`叶子键 en-us=${en.size} zh-cn=${zh.size}（差集 ${missingInZh.length + missingInEn.length}）`)
  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
