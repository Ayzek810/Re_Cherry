/**
 * check-imports —— 每个 import/export/require/dynamic-import 说明符都必须在磁盘上解析得到。
 *
 * 覆盖：相对路径（含 NodeNext 的 `./x.js` → `./x.ts`）、别名（@main/@renderer/@shared/@types/
 * @logger/@mcp-trace，按文件归属选用 node/web 两张表）、`?url` 等查询后缀、资源文件、裸包
 * （已安装或已在 package.json 声明）、node: 内置与 electron。
 */
'use strict'

const C = require('./lib/common')

function run() {
  const report = C.createReport('check-imports')
  const tables = C.aliasTables()
  const files = C.walkSources()
  let specifiers = 0
  const forms = new Map()

  for (const file of files) {
    let code
    try {
      code = C.readText(file)
    } catch (error) {
      report.fail(`${C.rel(file)} 无法读取: ${error.message}`)
      continue
    }
    for (const { spec, form, line } of C.extractSpecifiers(code)) {
      specifiers += 1
      forms.set(form, (forms.get(form) || 0) + 1)
      const result = C.resolveSpecifier(file, spec, tables)
      if (!result.ok) report.fail(`${C.rel(file)}:${line} [${form}] ${result.detail}`)
    }
  }

  report.note(
    `扫描 ${files.length} 个源文件、${specifiers} 个说明符（` +
      [...forms.entries()].map(([k, v]) => `${k}=${v}`).join(' ') +
      '）'
  )
  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
