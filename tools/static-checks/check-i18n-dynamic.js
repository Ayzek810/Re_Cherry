/**
 * check-i18n-dynamic —— 模板字面量形式的 i18n 键（ t(`error.${code}`) ）也要有账。
 *
 * 这类键在源码里没有点号字面量（`check-i18n-keys` 看不见），若不登记，剪枝时同样会静默丢文案。
 * 本检查把每个**形状**（把 `${...}` 归一为 `${}`）与 `i18n-dynamic-registry.json` 对账：
 *   - 未登记的形状 → 失败（新增动态键必须显式登记）；
 *   - 登记了 `expandsTo` → 每个目标键必须在两个语言包里解析得到；
 *   - 登记了 `notEnumerable` + 理由 → 通过，并把理由打出来（**静态不可枚举的正当豁免**，
 *     例如键的后半来自运行时错误文本，且代码里有 `i18n.exists()` 守卫按原文回退）；
 *   - 既没枚举也没说明理由 → warning（"已登记但未交代展开面"）。
 *
 * 另：会话导入器注册表（`availableImporters`）里的每个导入器都必须有
 * `import.<name>.assistant_name` 两语键——导入时用它给生成的助手命名
 * （`ImportService.ts` 的  `import.${importer.name.toLowerCase()}.assistant_name` ）。
 * **注意**：本项早期版本按 `conversationImporter`（小写 c）搜注册表而漏判，
 * 实际类型名是 `ConversationImporter` / 注册表变量是 `availableImporters`。
 * 教训：搜"注册表在不在"必须同时搜类型名、变量名与用法三种写法。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const C = require('./lib/common')

const REGISTRY = path.join(__dirname, 'i18n-dynamic-registry.json')

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
    return { shapes: Array.isArray(raw.shapes) ? raw.shapes : [] }
  } catch {
    return null
  }
}

function saveRegistry(registry) {
  fs.writeFileSync(
    REGISTRY,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          '登记动态 i18n 键形状：expandsTo 声明可枚举的展开面（逐键校验两语）；' +
          'notEnumerable 则要写清为什么静态枚举不了（评审时单独看这两项）',
        shapes: registry.shapes
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

/** 找出所有带点号的模板字面量，归一为形状。 */
function collectShapes(files, namespaces) {
  const found = new Map() // shape → { file, line }
  for (const file of files) {
    const clean = C.stripComments(fs.readFileSync(file, 'utf8'))
    // 捕获模板字面量的内容（不含首尾反引号）：`[^`$]*` 打头，`${` 之后吃到闭引号前
    const re = /`([^`$]*\$\{[^`]*)/g // 粗筛：含 ${...} 的模板字面量
    let m
    while ((m = re.exec(clean)) !== null) {
      const shape = m[1].replace(/\$\{[^}]*\}/g, '${}')
      const head = shape.split('.')[0]
      if (!shape.includes('.') || !namespaces.has(head)) continue
      if (!found.has(shape)) {
        found.set(shape, { file: C.rel(file), line: clean.slice(0, m.index).split('\n').length })
      }
    }
  }
  return found
}

/** 导入器注册表核对：availableImporters 的每个导入器都要有 import.<name>.assistant_name。 */
function checkImporters(report, en, zh) {
  const importDir = path.join(C.REPO_ROOT, 'src/renderer/src/services/import')
  if (!fs.existsSync(importDir)) {
    report.note('导入器目录不存在（services/import），本项跳过')
    return
  }
  const files = C.walkFiles(C.REPO_ROOT, { exts: new Set(['.ts', '.tsx']), dirs: ['src/renderer/src/services/import'] })
  let registrySource = null
  let registryFile = null
  for (const file of files) {
    const text = C.stripComments(fs.readFileSync(file, 'utf8'), { maskTemplates: true })
    if (/availableImporters\s*(?::[^=]*)?=\s*\[/.test(text)) {
      registrySource = text
      registryFile = file
      break
    }
  }
  if (registrySource === null) {
    report.fail('未找到导入器注册表（availableImporters）；若该功能已被移除，请同步删除本项检查并说明')
    return
  }

  const listMatch = registrySource.match(/availableImporters\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/)
  const classNames = [...(listMatch ? listMatch[1] : '').matchAll(/new\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  if (classNames.length === 0) {
    report.warn(`导入器注册表里没解析出任何导入器（${C.rel(registryFile)}）——空注册表也要确认是否符合预期`)
    return
  }

  for (const className of classNames) {
    // 找该类的定义文件与其 name 字面量
    const classFile = files.find((f) =>
      new RegExp(`class\\s+${className}\\b`).test(C.stripComments(fs.readFileSync(f, 'utf8'), { maskTemplates: true }))
    )
    if (!classFile) {
      report.fail(`导入器类 ${className} 找不到定义文件（注册表引用了不存在的东西）`)
      continue
    }
    const classText = C.stripComments(fs.readFileSync(classFile, 'utf8'))
    const nameMatch = classText.match(/\bname\s*[:=]\s*['"]([^'"]+)['"]/)
    if (!nameMatch) {
      report.warn(`导入器 ${className}（${C.rel(classFile)}）没有字符串字面量 name，无法核对文案键`)
      continue
    }
    const key = `import.${nameMatch[1].toLowerCase()}.assistant_name`
    for (const [lang, bundle] of [
      ['en-us', en],
      ['zh-cn', zh]
    ]) {
      if (typeof C.getDotted(bundle, key) !== 'string') {
        report.fail(
          `${lang} 缺少导入器助手名文案: ${key}（导入器 ${className} 的 name="${nameMatch[1]}"，` +
            `用法在 ImportService.ts；缺了会退化成英文默认值）`
        )
      }
    }
    report.note(`导入器 ${className} → ${key} 已核对`)
  }
}

function run({ updateRegistry = false } = {}) {
  const report = C.createReport('check-i18n-dynamic')
  const en = C.localeBundle('en-us')
  const zh = C.localeBundle('zh-cn')
  const namespaces = new Set(Object.keys(en))
  const files = C.walkFiles(C.REPO_ROOT, { exts: C.SOURCE_EXTS, dirs: C.I18N_SCAN_DIRS })
  const shapes = collectShapes(files, namespaces)
  const registry = loadRegistry()

  if (registry === null || updateRegistry) {
    const existing = new Map((registry ? registry.shapes : []).map((s) => [s.shape, s]))
    const merged = [...shapes.entries()].map(([shape, where]) => {
      const prior = existing.get(shape)
      return prior
        ? { ...prior, where: `${where.file}:${where.line}` }
        : { shape, where: `${where.file}:${where.line}` }
    })
    saveRegistry({ shapes: merged })
    report.note(`注册表${registry === null ? '首次生成' : '已合并刷新'}：${merged.length} 个形状（本次不判失败）`)
    return report
  }

  const registered = new Map(registry.shapes.map((s) => [s.shape, s]))
  for (const [shape, where] of shapes) {
    const entry = registered.get(shape)
    if (!entry) {
      report.fail(`未登记的动态 i18n 键形状: ${shape}（${where.file}:${where.line}）`)
      continue
    }
    if (Array.isArray(entry.expandsTo) && entry.expandsTo.length > 0) {
      for (const key of entry.expandsTo) {
        if (!C.i18nResolves(en, key)) report.fail(`动态展开键缺于 en-us: ${key}（形状 ${shape}）`)
        if (!C.i18nResolves(zh, key)) report.fail(`动态展开键缺于 zh-cn: ${key}（形状 ${shape}）`)
      }
      report.note(`形状 ${shape}：已枚举 ${entry.expandsTo.length} 个展开键并核对通过`)
    } else if (typeof entry.notEnumerable === 'string' && entry.notEnumerable.length > 0) {
      report.note(`形状 ${shape}：声明为静态不可枚举 —— ${entry.notEnumerable}`)
    } else {
      report.warn(`动态形状已登记但未交代展开面（既无 expandsTo 也无 notEnumerable 理由）: ${shape}`)
    }
  }
  for (const shape of registered.keys()) {
    if (!shapes.has(shape)) report.warn(`注册表里的形状在源码中已不再出现: ${shape}（可 --update-registry 收紧）`)
  }
  report.note(`源码形状 ${shapes.size} 个 / 注册表 ${registered.size} 个`)

  checkImporters(report, en, zh)
  return report
}

module.exports = { run }
if (require.main === module) {
  C.reportAndExit(run({ updateRegistry: process.argv.includes('--update-registry') }))
}
