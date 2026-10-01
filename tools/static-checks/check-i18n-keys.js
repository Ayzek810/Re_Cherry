/**
 * check-i18n-keys —— 源码里以语言包命名空间开头的点号字符串字面量，必须在**两个**语言包里解析得到。
 *
 * 与 i18next 的复数/上下文语义对齐：`key` 不存在但 `key_one` / `key_other` / `key_male` 等存在，
 * 视为解析成功（详见 lib/common.js 的 i18nResolves）。
 *
 * 基线机制（本项的关键设计）：比对 `i18n-baseline.json`，**只让"新增的缺失"失败**。
 * 存量缺口（上游遗产）记在基线里不阻塞，这样本检查才敢被当门禁用。
 * 首次运行或需要刷新基线时：`node check-i18n-keys.js --update-baseline`。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const C = require('./lib/common')

const BASELINE = path.join(__dirname, 'i18n-baseline.json')

/**
 * 明显不是 i18n 键的点号字符串（本仓实测的假阳性类别）：
 *   1. 文件名/资源名：`settings.json`、`notes.txt` —— 首段撞上同名命名空间；
 *   2. 域名：`files.domain.net`；
 *   3. 存储键：`keyv.get('memory.wait.settings')` —— `memory` 是命名空间但不是文案键；
 *   4. 结构性 data 属性：`data-ui="paintings.view"`、`data-testid="a.b"` —— V2 移植件
 *      的 QA/结构标记，值恰好是点号串但没有任何文案语义。
 * 排除它们是为了让报告可信：把噪音混进基线，门禁很快就会被当成"总是红的"而忽视。
 */
const FILE_LIKE_TAIL =
  /^(json|jsonc|txt|md|markdown|png|jpe?g|gif|svg|webp|ico|css|less|scss|html?|jsx?|tsx?|mjs|cjs|log|db|sqlite|yaml|yml|toml|ini|env|lock|map|docx?|pptx?|xlsx?|odt|pdf)$/i
const STORAGE_KEY_CONTEXT = /\b(keyv|localStorage|sessionStorage|indexedDB)\b\s*[.(]/
/** 主机名形态（`files.domain.net` 这类：整串是域名而非文案键）。 */
const COMMON_TLD = /^(net|com|org|io|dev|ai|cn|co|me|app|xyz|info)$/i
const HOSTNAME_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/
/** 结构标记属性（`data-ui="x.y"` / `data-testid="x.y"`）：值不是文案。
 *  注意判定必须**落到该键本身位于属性值内**——早期版本只判「这一行里有 data-* 属性」，
 *  于是同一行里真实的 `t('foo.bar')`（如 `<div data-ui="x" aria-label={t('a.b')}>`）会被误排除。 */
const STRUCTURAL_ATTR_NAME = /\bdata-(?:ui|testid|test-id|state|slot|role|kind)\s*=\s*["'`]/
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function isStructuralAttributeValue(key, sourceLine) {
  if (!STRUCTURAL_ATTR_NAME.test(sourceLine)) return false
  // 该键必须出现在某个 data-* 属性的引号值里
  return new RegExp(
    `\\bdata-(?:ui|testid|test-id|state|slot|role|kind)\\s*=\\s*["'\`][^"'\`]*${escapeRegExp(key)}`
  ).test(sourceLine)
}

function looksLikeNonI18nKey(key, sourceLine) {
  const tail = key.split('.').pop() || ''
  if (FILE_LIKE_TAIL.test(tail)) return 'file-or-asset-name'
  if (STORAGE_KEY_CONTEXT.test(sourceLine)) return 'storage-key'
  if (COMMON_TLD.test(tail) && HOSTNAME_SHAPE.test(key)) return 'hostname'
  if (isStructuralAttributeValue(key, sourceLine)) return 'structural-attribute'
  return null
}

function loadBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    return new Set(Array.isArray(raw.misses) ? raw.misses : [])
  } catch {
    return null // 不存在 = 首次运行
  }
}

function saveBaseline(misses, note) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note,
        misses: [...misses].sort()
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

function run({ updateBaseline = false } = {}) {
  const report = C.createReport('check-i18n-keys')
  const en = C.localeBundle('en-us')
  const zh = C.localeBundle('zh-cn')
  const namespaces = new Set(Object.keys(en))
  const files = C.walkFiles(C.REPO_ROOT, { exts: C.SOURCE_EXTS, dirs: C.I18N_SCAN_DIRS })
  const misses = new Map() // "file:key" → { file, line, key, missingIn }
  const skipped = new Map() // 假阳性类别 → 计数（如实记账，便于复核）
  const unknownNamespace = new Map() // "file:key" → { file, line, key }（t() 调用里首段不是已知命名空间）

  for (const file of files) {
    const clean = C.stripComments(C.readText(file))
    const cleanLines = clean.split('\n')
    // 未知命名空间规则只对**确实用 i18next**的文件生效：有的模块自带本地 `t()`（如
    // apiGateway/openapiDocs.ts 的 DOCS_STRINGS 表），那些键不归语言包管。
    const usesI18next = /from\s+['"](?:react-i18next|i18next)['"]|useTranslation\(/.test(clean)
    const re = /['"`]([A-Za-z][\w]*(?:\.[\w]+)+)['"`]/g
    let m
    while ((m = re.exec(clean)) !== null) {
      const key = m[1]
      const head = key.split('.')[0]
      if (!namespaces.has(head)) {
        // 教训：首段不是已知命名空间就跳过，等于让「整段命名空间缺失」
        // 永远不红——`richEditor.*` 71 处引用、两语言包 0 命中，笔记编辑器长期渲染原始 key。
        // 现在只对**明确是 i18n 调用**的形态判失败（t('ns.key') / i18n.t('ns.key')），
        // 避免把任意点号字符串（配置路径、data-* 结构标记等）误判成文案键。
        const before = clean.slice(Math.max(0, m.index - 40), m.index)
        if (usesI18next && /\b(?:i18n\.)?t\(\s*$/.test(before)) {
          const line = clean.slice(0, m.index).split('\n').length
          const reason = looksLikeNonI18nKey(key, cleanLines[line - 1] || '')
          if (reason === null) {
            unknownNamespace.set(`${C.rel(file)}:${key}`, { file: C.rel(file), line, key })
          } else {
            skipped.set(reason, (skipped.get(reason) || 0) + 1)
          }
        }
        continue
      }
      const line = clean.slice(0, m.index).split('\n').length
      const reason = looksLikeNonI18nKey(key, cleanLines[line - 1] || '')
      if (reason !== null) {
        skipped.set(reason, (skipped.get(reason) || 0) + 1)
        continue
      }
      const missingIn = []
      if (!C.i18nResolves(en, key)) missingIn.push('en-us')
      if (!C.i18nResolves(zh, key)) missingIn.push('zh-cn')
      if (missingIn.length === 0) continue
      misses.set(`${C.rel(file)}:${key}`, { file: C.rel(file), line, key, missingIn })
    }
  }

  for (const [, info] of unknownNamespace) {
    report.fail(
      `未登记命名空间: ${info.key}（${info.file}:${info.line}）——首段不是任何语言包的顶层命名空间，` +
        `该文案永远渲染成 key 本身`
    )
  }

  const baseline = loadBaseline()
  if (baseline === null || updateBaseline) {
    saveBaseline(
      [...misses.keys()],
      updateBaseline ? '手动刷新' : '首次生成：把当时的存量缺失一次性记入，之后只对新增缺失失败'
    )
    report.note(`基线${baseline === null ? '首次生成' : '已刷新'}：记入 ${misses.size} 条存量缺失（本次不判失败）`)
    return report
  }

  const added = [...misses.entries()].filter(([id]) => !baseline.has(id))
  const fixed = [...baseline].filter((id) => !misses.has(id))
  for (const [, info] of added) {
    report.fail(`新增缺失键: ${info.key}（${info.file}:${info.line}，缺于 ${info.missingIn.join('/')}）`)
  }
  report.note(
    `扫描 ${files.length} 个文件；当前缺失 ${misses.size} 条，基线 ${baseline.size} 条；` +
      `新增 ${added.length}，已修复 ${fixed.length}` +
      (skipped.size > 0 ? `；已排除假阳性 ${[...skipped.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}` : '')
  )
  if (fixed.length > 0) report.warn(`基线里有 ${fixed.length} 条已不再缺失（可 --update-baseline 收紧）`)
  return report
}

module.exports = { run }
if (require.main === module) {
  C.reportAndExit(run({ updateBaseline: process.argv.includes('--update-baseline') }))
}
