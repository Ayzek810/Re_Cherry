/**
 * check-main-i18n —— **主进程必须能读到自己的字符串**。
 *
 * 背景（本项守的正是一次真实事故）：主进程按**对象值**取文案
 * （`const { tray: trayLocale } = locale.translation`），因此 `'tray.show_window'` 这种字面量
 * 在源码里**根本不存在**——任何"按字面量引用"驱动的剪枝都会把整个 tray 命名空间删掉，
 * 而普通文本检查（含 i18n 键检查）看不见这个损失。
 *
 * 本检查三条：
 *   1. 被对象值解构的命名空间（含别名）必须在**两个**语言包里存在，且成员是字符串；
 *   2. 该命名空间上被点取的成员（`trayLocale.show_window`）必须真实存在；
 *   3. 主进程里的 `t('a.b.c')` 字面量必须在两个语言包里解析得到。
 */
'use strict'

const path = require('node:path')

const C = require('./lib/common')

/** 主进程源码文件（不含 tests）。 */
function mainFiles() {
  return C.walkFiles(C.REPO_ROOT, { exts: new Set(['.ts', '.tsx']), dirs: ['src/main', 'src/preload'] })
}

/** 抽 `const { a, b: localB } = X.translation` 的解构项。 */
function destructuredNamespaces(code) {
  const clean = C.stripComments(code)
  const out = []
  const re = /const\s*\{([^}]+)\}\s*=\s*[\w$.]+\.translation\b/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const line = clean.slice(0, m.index).split('\n').length
    for (const raw of m[1].split(',')) {
      const item = raw.trim()
      if (!item) continue
      const asMatch = item.match(/^([\w$]+)\s*:\s*([\w$]+)$/)
      out.push(asMatch ? { namespace: asMatch[1], local: asMatch[2], line } : { namespace: item, local: item, line })
    }
  }
  return out
}

function run() {
  const report = C.createReport('check-main-i18n')
  const en = C.localeBundle('en-us')
  const zh = C.localeBundle('zh-cn')
  const files = mainFiles()

  // 1 + 2：对象值访问的命名空间与成员
  const seen = new Set()
  for (const file of files) {
    const code = C.readText(file)
    for (const { namespace, local, line } of destructuredNamespaces(code)) {
      if (seen.has(`${namespace}`)) {
        // 已校验过命名空间本身，仍需校验该文件的成员取用
      } else {
        seen.add(namespace)
        for (const [lang, bundle] of [
          ['en-us', en],
          ['zh-cn', zh]
        ]) {
          const value = C.getDotted(bundle, namespace)
          if (value === undefined) report.fail(`${lang} 缺少主进程对象值访问的命名空间: ${namespace}`)
          else if (typeof value !== 'object') report.fail(`${lang} 的 ${namespace} 不是对象（剪枝事故的典型形态）`)
        }
      }
      // 成员点取：排除解构行自身
      const clean = C.stripComments(code)
      const memberRe = new RegExp(`\\b${local.replace(/\$/g, '\\$')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
      let mm
      while ((mm = memberRe.exec(clean)) !== null) {
        const member = mm[1]
        if (member === 'translation' || member === 'length') continue
        const dotted = `${namespace}.${member}`
        for (const [lang, bundle] of [
          ['en-us', en],
          ['zh-cn', zh]
        ]) {
          if (typeof C.getDotted(bundle, dotted) !== 'string') {
            report.fail(`${lang} 缺少主进程点取的文案: ${dotted}（${C.rel(file)}:${line}，本地名 ${local}）`)
          }
        }
      }
    }
  }
  report.note(`对象值访问的命名空间: ${[...seen].join(', ') || '(none)'}`)

  // 3：t('a.b.c') 字面量
  let literals = 0
  for (const file of files) {
    const clean = C.stripComments(C.readText(file))
    const re = /\bt\(\s*['"]([a-zA-Z][\w.]*)['"]\s*\)/g
    let m
    while ((m = re.exec(clean)) !== null) {
      const key = m[1]
      if (!key.includes('.')) continue
      literals += 1
      const line = clean.slice(0, m.index).split('\n').length
      for (const [lang, bundle] of [
        ['en-us', en],
        ['zh-cn', zh]
      ]) {
        if (!C.i18nResolves(bundle, key)) report.fail(`${lang} 缺少主进程 t() 键: ${key}（${C.rel(file)}:${line}）`)
      }
    }
  }
  report.note(`主进程 t() 字面量: ${literals} 个`)

  // 4：locales.ts 的取样通道仍指向真实文件
  const localesFile = path.join(C.REPO_ROOT, 'src/main/utils/locales.ts')
  if (!require('node:fs').existsSync(localesFile)) {
    report.fail('src/main/utils/locales.ts 不存在（主进程文案通道缺失）')
  } else {
    const src = C.readText(localesFile)
    for (const lang of ['en-us', 'zh-cn']) {
      if (!src.includes(`locales/${lang}.json`)) report.fail(`locales.ts 未引用 ${lang}.json`)
    }
    if (!/translation/.test(src)) report.fail('locales.ts 里没有 translation 包裹（主进程按对象值取文案会读空）')
  }

  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
