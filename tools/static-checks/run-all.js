#!/usr/bin/env node
/**
 * 静态校验套件总入口。
 *
 *   node run-all.js                 # 跑全部十项
 *   node run-all.js --only=check-imports
 *   node run-all.js --quiet         # 只打印结论与失败行
 *
 * 存在意义：当 node_modules / pnpm / 类型检查器都不可用时（本项目长期如此），
 * 仍有一道**机器防线**拦住"删了还在被引用的东西""改了名字没改引用""i18n 被剪没了"这类回归。
 *
 * 退出码：0 = 十项全绿；1 = 有失败项。
 */
'use strict'

const path = require('node:path')

const C = require('./lib/common')

const CHECKS = [
  ['check-imports', '每个 import/export/require/dynamic-import 说明符都能在磁盘上解析'],
  ['check-symbols', '每个具名导入的名字在目标文件里真的导出了'],
  ['check-syntax', '每个 .ts 都能被解析（语法级，非类型级）'],
  ['check-configs', '配置文件可解析、无 BOM、patches 与 patchedDependencies 1:1（含 lockfile 一致）'],
  ['check-i18n-parity', 'en-us / zh-cn 叶子键集合一致'],
  ['check-main-i18n', '主进程按对象值/字面量取到的文案都真实存在'],
  ['check-i18n-keys', '点号键字面量在两语都能解析（基线制：只对新增缺失失败）'],
  ['check-i18n-dynamic', '模板字面量动态键的形状已登记，且声明的展开面可解析'],
  ['check-upstream', '与上游参考树逐条对账（派生版的非预期分叉＝最大回归风险；无参考树时跳过）'],
  [
    'check-package-runtime-closure',
    '根 package.json 出发沿正则依赖边收集的闭包，覆盖每个包 dep+peer 的运行期边（防纯 peer 包被打包遗漏）'
  ]
]

function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)
  const quiet = process.argv.includes('--quiet')

  const results = []
  for (const [name, desc] of CHECKS) {
    if (only && name !== only) continue
    const startedAt = process.hrtime.bigint()
    let report
    try {
      report = require(path.join(__dirname, `${name}.js`)).run()
    } catch (error) {
      report = C.createReport(name)
      report.fail(`检查自身抛错（这是套件的 bug，不是项目的 bug）: ${error && error.stack}`)
    }
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    results.push({ name, desc, report, ok: report.failures.length === 0, ms })
  }

  if (!quiet) {
    process.stdout.write(`静态校验套件 @ ${C.REPO_ROOT}\n`)
    process.stdout.write(`node ${process.version}\n\n`)
  }
  for (const { name, desc, report, ok, ms } of results) {
    process.stdout.write(
      `${ok ? '  OK  ' : ' FAIL '} ${name.padEnd(20)} ${String(Math.round(ms)).padStart(5)} ms  ${desc}\n`
    )
    if (!quiet || !ok) {
      for (const note of report.notes) process.stdout.write(`         · ${note}\n`)
      for (const warn of report.warnings) process.stdout.write(`         ! ${warn}\n`)
      for (const failure of report.failures) process.stdout.write(`         ✗ ${failure}\n`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  const totalFailures = results.reduce((sum, r) => sum + r.report.failures.length, 0)
  const total = results.length
  const totalMs = Math.round(results.reduce((sum, r) => sum + r.ms, 0))
  process.stdout.write(
    `\n${failed.length === 0 ? `EXIT=0 全部 ${total} 项全绿` : `EXIT=1 ${failed.length}/${total} 项失败`}` +
      `（共 ${totalFailures} 条失败，耗时 ${totalMs} ms）\n`
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}

main()
