/**
 * 静态校验套件的共享底座（纯 Node 内置模块，零依赖）。
 *
 * 为什么零依赖：这套检查的存在意义就是"当 node_modules / pnpm 不可用时仍能守门"
 * 时代沙箱既无依赖也不能跑 pnpm，八项检查全靠 Node 内置模块完成。
 * 因此不要为了省事引入 yaml / jsonc-parser / typescript 之类的包。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * 仓库根：**位置无关**——从本文件向上找到第一个同时含 `package.json` 与 `src/main` 的目录。
 * 工具可以放在仓库里（`tools/`）、仓库外、或任何副本中，都不影响解析。
 * `RC_REPO` 可显式覆盖（特殊布局用）。
 */
function findRepoRoot(start) {
  let dir = start
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src', 'main'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`static-checks: cannot locate the repository root above ${start} (needs package.json + src/main)`)
}

const REPO_ROOT = process.env.RC_REPO ? path.resolve(process.env.RC_REPO) : findRepoRoot(__dirname)
/** 工作区根 = 仓库根的上一级：上游参考树等外部资产按约定放在仓库旁。 */
const WORKSPACE_ROOT = path.dirname(REPO_ROOT)

/** 一律跳过的目录（生成物/依赖/缓存）。 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.tsbuildinfo',
  'out',
  'dist',
  'build',
  'coverage',
  '.vite',
  'release'
])

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

/** 检查的源码根（相对仓库根）。 */
const SOURCE_ROOTS = ['src', 'packages', 'scripts', 'tests']

/** 递归收集文件（只返回常规文件，跳过 IGNORED_DIRS）。 */
function walkFiles(root, { exts, dirs = SOURCE_ROOTS, includeRootFiles = false } = {}) {
  const found = []
  const visit = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        visit(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (exts && !exts.has(path.extname(entry.name))) continue
      found.push(path.join(dir, entry.name))
    }
  }
  for (const d of dirs) visit(path.join(root, d))
  if (includeRootFiles) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (exts && !exts.has(path.extname(entry.name))) continue
      if (/\.config\.[cm]?[jt]s$/.test(entry.name) || entry.name === 'playwright.config.ts') {
        found.push(path.join(root, entry.name))
      }
    }
  }
  return found
}

/** 源文件全量（含根级配置文件）。 */
function walkSources(root = REPO_ROOT) {
  return walkFiles(root, { exts: SOURCE_EXTS, includeRootFiles: true })
}

/** 相对仓库根的 POSIX 风格路径（报告用）。 */
function rel(abs, root = REPO_ROOT) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8')
}

/** 读 JSON，失败抛错（调用方决定是否算失败）。 */
function readJson(abs) {
  return JSON.parse(readText(abs))
}

/** 是否有 UTF-8 BOM。 */
function hasBom(abs) {
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(3)
    const read = fs.readSync(fd, buf, 0, 3, 0)
    return read === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 该位置是否可能开启一个正则字面量（标准启发式：看上一个有意义 token）。
 * 刻意**不把 `<` / `>` 当正则前导**——否则 JSX 的 `</div>` 会被当成正则起头，
 * 在 .tsx 里造成状态机错位（本仓有 398 个 .tsx）。
 */
function isRegexStart(prevToken) {
  if (prevToken === '') return true
  const last = prevToken.slice(-1)
  if (/[([{,;:=!&|?+\-*%~^]/.test(last)) return true
  return /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(prevToken)
}

/** 从 `start` 处的 `/` 起吃掉一个正则字面量；不成对返回 null（当除法处理）。 */
function consumeRegexLiteral(code, start) {
  let i = start + 1
  let inClass = false
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n') return null // 正则不能跨行
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      i += 1
      while (i < code.length && /[a-z]/i.test(code[i])) i += 1 // flags
      return code.slice(start, i)
    }
    i += 1
  }
  return null
}

/**
 * 剥掉注释（尊重字符串、模板字面量、正则字面量与 `${}` 表达式嵌套），避免注释里的
 * import/键名被当成代码。
 *
 * `options.maskTemplates = true` 时**把模板字面量的文本部分掩成空格**（保留换行与
 * `${...}` 表达式）——用于说明符/符号抽取：本仓的测试会在模板里写示例代码
 * （`findStringLiteral(project, \`import { foo } from 'some-module'\`)`），
 * 不掩码就会当成真 import 报假阳性。
 * i18n 检查**不要**开这个选项：它需要看见模板字面量里以命名空间开头的键。
 *
 * 基于状态栈实现（code/template/templateExpr/line/block/single/double），
 * 支持表达式里再出现字符串、注释与嵌套模板；正则字面量整段吃掉，防止其中的引号错位。
 */
function stripComments(code, options = {}) {
  const maskTemplates = options.maskTemplates === true
  let out = ''
  const stack = ['code']
  // 每个 templateExpr 帧各自的 `{}` 深度（修复：嵌套模板 `${` `${}` 会重置外层深度，
  // 导致闭合错位、之后整个文件被当成模板文本掩掉—— 在 topics.ts 踩中）
  const exprDepths = []
  let prevToken = ''
  let i = 0

  const track = (text) => {
    const trimmed = text.trim()
    if (trimmed) prevToken = (prevToken + trimmed).slice(-24)
  }

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]
    const state = stack[stack.length - 1]

    if (state === 'line') {
      if (ch === '\n') {
        stack.pop()
        out += ch
      }
      i += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        stack.pop()
        i += 2
        continue
      }
      if (ch === '\n') out += ch // 保留行号
      i += 1
      continue
    }
    if (state === 'single' || state === 'double') {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) stack.pop()
      i += 1
      continue
    }
    if (state === 'template') {
      if (ch === '\\') {
        out += maskTemplates ? '  ' : ch + (next ?? '')
        i += 2
        continue
      }
      if (ch === '`') {
        stack.pop()
        out += ch
        i += 1
        continue
      }
      if (ch === '$' && next === '{') {
        out += '${'
        stack.push('templateExpr')
        exprDepths.push(1)
        i += 2
        continue
      }
      out += maskTemplates ? (ch === '\n' ? '\n' : ' ') : ch
      i += 1
      continue
    }
    // state === 'code' 或 'templateExpr'：共用代码态扫描
    if (state === 'templateExpr') {
      const top = exprDepths.length - 1
      if (ch === '{') {
        exprDepths[top] += 1
        out += ch
        i += 1
        continue
      }
      if (ch === '}') {
        exprDepths[top] -= 1
        out += ch
        i += 1
        if (exprDepths[top] === 0) {
          exprDepths.pop()
          stack.pop()
        }
        continue
      }
    }
    if (ch === '/' && next !== '/' && next !== '*') {
      if (isRegexStart(prevToken)) {
        const literal = consumeRegexLiteral(code, i)
        if (literal !== null) {
          out += literal
          track(literal)
          i += literal.length
          continue
        }
      }
    }
    if (ch === '/' && next === '/') {
      stack.push('line')
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      stack.push('block')
      i += 2
      continue
    }
    if (ch === "'") stack.push('single')
    else if (ch === '"') stack.push('double')
    else if (ch === '`') stack.push('template')
    out += ch
    track(ch)
    i += 1
  }
  return out
}

/** JSONC 容忍：去注释 + 去尾逗号。用于 .oxlintrc.json / biome.jsonc / tsconfig（若带注释）。 */
function parseJsonc(text) {
  const noComments = stripComments(text)
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailingCommas)
}

/**
 * 极简 YAML 子集解析：缩进映射 + 序列 + 标量（引号/裸词）。
 * 只服务 pnpm-workspace.yaml / electron-builder.yml 的结构检查；
 * 遇到块标量（| >）或锚点（& *）等未支持构造时把该值记为字符串标记，不静默算通过。
 */
function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/)
  const root = {}
  const stack = [{ indent: -1, value: root }]

  const containerFor = (probeIndex, parentIndent) => {
    for (let j = probeIndex; j < lines.length; j += 1) {
      const raw = lines[j]
      if (!raw.trim() || raw.trim().startsWith('#')) continue
      const ind = raw.match(/^\s*/)[0].length
      if (ind <= parentIndent) break
      return raw.trim().startsWith('- ') ? [] : {}
    }
    return {}
  }

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^\s*/)[0].length
    const line = raw.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1].value

    if (line.startsWith('- ')) {
      if (!Array.isArray(top)) continue // 结构异常（数组项落在非数组容器下）：忽略该行
      const rest = line.slice(2).trim()
      const kv = rest.match(/^([\w@./$-]+):\s*(.*)$/)
      if (kv) {
        const obj = {}
        obj[kv[1]] = scalar(kv[2])
        top.push(obj)
      } else {
        top.push(scalar(rest))
      }
      continue
    }

    const kv = line.match(/^([^:]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].trim().replace(/^['"]|['"]$/g, '')
    const valueText = kv[2].trim()
    if (valueText === '') {
      const child = containerFor(idx + 1, indent)
      top[key] = child
      stack.push({ indent, value: child })
    } else {
      top[key] = scalar(valueText)
    }
  }
  return root
}

function scalar(text) {
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  if (/^[|>]/.test(text)) return `{block-scalar:${text[0]}}`
  if (/^[&*]/.test(text)) return `{anchor:${text}}`
  return text.replace(/^['"]|['"]$/g, '')
}

/** 从 tsconfig 的 compilerOptions.paths 生成别名表。 */
function loadAliasTable(tsconfigAbs) {
  const cfg = parseJsonc(readText(tsconfigAbs))
  const paths = (cfg.compilerOptions && cfg.compilerOptions.paths) || {}
  const table = []
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? targets[0] : targets
    if (typeof target !== 'string') continue
    table.push({
      prefix: pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern,
      wildcard: pattern.endsWith('/*'),
      target: target.replace(/^\.\//, ''),
      targetWildcard: target.endsWith('/*')
    })
  }
  return table
}

function aliasTables(root = REPO_ROOT) {
  const node = loadAliasTable(path.join(root, 'tsconfig.node.json'))
  const web = loadAliasTable(path.join(root, 'tsconfig.web.json'))
  return { node, web }
}

/** 该文件用哪张别名表（renderer 用 web，其余用 node）。 */
function aliasTableFor(absFile, tables) {
  const r = rel(absFile)
  return r.startsWith('src/renderer/') ? tables.web : tables.node
}

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.d.ts']

/** Node 内置模块（含 `fs/promises` 这类子路径；无 `node:` 前缀的写法也必须认）。 */
const BUILTIN_MODULES = new Set(require('node:module').builtinModules)

function isBuiltinSpecifier(spec) {
  if (spec.startsWith('node:')) return true
  if (BUILTIN_MODULES.has(spec)) return true
  return BUILTIN_MODULES.has(spec.split('/')[0])
}

/** 把"无扩展名的绝对路径基"解析成真实存在的文件。 */
function resolveBase(base) {
  const direct = [base, `${base}.d.ts`, ...RESOLVE_EXTS.map((e) => base + e)]
  for (const cand of direct) {
    if (isFile(cand)) return cand
  }
  for (const e of RESOLVE_EXTS) {
    const cand = path.join(base, `index${e}`)
    if (isFile(cand)) return cand
  }
  // 资源类（显式扩展名由调用方保证）
  return null
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 去掉 vite 查询后缀（?url / ?raw / ?worker / ?asset / ?inline）。 */
function stripQuery(spec) {
  const q = spec.indexOf('?')
  return q === -1 ? spec : spec.slice(0, q)
}

/**
 * 解析一个 import/require 说明符。
 * @returns {{kind:string, ok:boolean, target?:string, detail?:string}}
 */
function resolveSpecifier(fromFile, specRaw, tables) {
  const spec = stripQuery(specRaw)
  if (spec === '') return { kind: 'empty', ok: false, detail: '空说明符' }

  // 相对（`.` / `..` 是合法的"当前目录 barrel"写法，本仓 types/chunk.ts 在用）
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.resolve(path.dirname(fromFile), spec)
    const hit = resolveBase(base) || resolveNodeNextJsToTs(base)
    return hit
      ? { kind: 'relative', ok: true, target: hit }
      : { kind: 'relative', ok: false, detail: `相对路径解析不到文件: ${rel(fromFile)} → ${spec}` }
  }

  // 别名
  for (const entry of aliasTableFor(fromFile, tables)) {
    let tail = null
    if (entry.wildcard) {
      if (spec === entry.prefix || !spec.startsWith(entry.prefix + '/')) continue
      tail = spec.slice(entry.prefix.length + 1)
    } else if (spec === entry.prefix) {
      tail = ''
    } else {
      continue
    }
    const mapped = entry.targetWildcard
      ? path.join(REPO_ROOT, entry.target.replace(/\/\*$/, ''), tail)
      : path.join(REPO_ROOT, entry.target)
    const hit = resolveBase(mapped) || resolveNodeNextJsToTs(mapped)
    return hit
      ? { kind: 'alias', ok: true, target: hit }
      : { kind: 'alias', ok: false, detail: `别名解析不到文件: ${rel(fromFile)} → ${spec} (${entry.prefix})` }
  }

  // 内置与协议
  if (spec.startsWith('bun:') || spec.startsWith('virtual:') || spec.startsWith('data:')) {
    return { kind: 'builtin', ok: true }
  }
  if (isBuiltinSpecifier(spec)) return { kind: 'builtin', ok: true }
  if (spec === 'electron' || spec.startsWith('electron/')) return { kind: 'builtin', ok: true }

  // 资源（显式扩展名）
  const ext = path.extname(spec)
  if (
    [
      '.css',
      '.scss',
      '.less',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.svg',
      '.webp',
      '.ico',
      '.woff',
      '.woff2',
      '.ttf',
      '.mp3',
      '.mp4',
      '.html',
      '.wasm',
      '.json',
      '.md'
    ].includes(ext)
  ) {
    const hit = resolveSpecifierAsset(fromFile, spec)
    return hit
      ? { kind: 'asset', ok: true, target: hit }
      : { kind: 'asset', ok: false, detail: `资源解析不到: ${rel(fromFile)} → ${spec}` }
  }

  // 裸包
  const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  const installed = isFile(path.join(REPO_ROOT, 'node_modules', pkgName, 'package.json'))
  // 纯类型模块：`import type { X } from 'mdast'` 由 `@types/mdast` 提供，没有运行时包
  const typedByDefinitelyTyped = isFile(
    path.join(REPO_ROOT, 'node_modules', '@types', pkgName.replace(/^@/, '').replace('/', '__'), 'package.json')
  )
  let declared = false
  try {
    const pkg = readJson(path.join(REPO_ROOT, 'package.json'))
    declared = Boolean(
      (pkg.dependencies && pkg.dependencies[pkgName]) ||
        (pkg.devDependencies && pkg.devDependencies[pkgName]) ||
        (pkg.optionalDependencies && pkg.optionalDependencies[pkgName])
    )
  } catch {
    declared = false
  }
  if (installed || declared || typedByDefinitelyTyped) return { kind: 'bare', ok: true }
  return { kind: 'bare', ok: false, detail: `裸包未安装也未声明: ${rel(fromFile)} → ${spec}` }
}

/** NodeNext 的 `./x.js` 实际源文件是 `./x.ts`。 */
function resolveNodeNextJsToTs(base) {
  for (const ext of ['.js', '.mjs', '.cjs']) {
    if (!base.endsWith(ext)) continue
    const stem = base.slice(0, -ext.length)
    for (const alt of ['.ts', '.tsx', '.mts', '.cts', '.d.ts']) {
      if (isFile(stem + alt)) return stem + alt
    }
    const idx = path.join(stem, 'index.ts')
    if (isFile(idx)) return idx
  }
  return null
}

/** 资源说明符：本地相对/绝对各试一处；裸包形式则进 node_modules 找包内子路径。 */
function resolveSpecifierAsset(fromFile, spec) {
  const candidates = []
  if (spec.startsWith('/')) {
    candidates.push(path.join(REPO_ROOT, 'src/renderer/public', spec))
    candidates.push(path.join(REPO_ROOT, 'src/renderer', spec))
    candidates.push(path.join(REPO_ROOT, spec))
  } else if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    candidates.push(path.resolve(path.dirname(fromFile), spec))
  } else {
    // 包内资源：katex/dist/katex.min.css、@xyflow/react/dist/style.css、emoji-picker-element-data/en/cldr/data.json
    const parts = spec.split('/')
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const rest = spec.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
    if (rest) candidates.push(path.join(REPO_ROOT, 'node_modules', pkgName, rest))
    candidates.push(path.resolve(path.dirname(fromFile), spec))
  }
  return candidates.find(isFile) || null
}

/** 抽取一个源文件里的全部说明符及行号（模板字面量文本已掩码，防止示例代码被当成真 import）。 */
function extractSpecifiers(code) {
  const clean = stripComments(code, { maskTemplates: true })
  const out = []
  const push = (index, spec, form) => {
    const line = clean.slice(0, index).split('\n').length
    out.push({ spec, form, line })
  }
  // 说明符子句一律限制在 `[^;'"]*?` 内：**不允许跨语句、不允许跨字符串**。
  // 反例（实测）：`export interface Foo {` 之后的惰性匹配会一路吃到几百行后
  // 某个 `from '${x}'`，把模板片段当成说明符；还有匹配到字符串内部 `'...\/import'` 的 `import`。
  // 前缀守卫 `(?<![\w'"$/])` 排除标识符/字符串里出现的关键字。
  const patterns = [
    { re: /(?<![\w'"$/])import\s+(?:type\s+)?([^;'"]*?)\sfrom\s*['"]([^'"]+)['"]/g, group: 2, form: 'import' },
    { re: /(?<![\w'"$/])import[ \t]*['"]([^'"]+)['"]/g, group: 1, form: 'import-side-effect' },
    { re: /(?<![\w'"$/])export\s+(?:type\s+)?([^;'"]*?)\sfrom\s*['"]([^'"]+)['"]/g, group: 2, form: 'export-from' },
    { re: /(?<![\w'"$/])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, group: 1, form: 'dynamic-import' },
    { re: /(?<![\w'"$/])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, group: 1, form: 'require' }
  ]
  for (const { re, group, form } of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(clean)) !== null) push(m.index, m[group], form)
  }
  return out
}

/** 抽取 `import { a, b as c }` 的具名导入（含 type 修饰；模板文本已掩码）。 */
function extractNamedImports(code) {
  const clean = stripComments(code, { maskTemplates: true })
  const out = []
  const re = /(?<![\w'"$/])import\s+(?:type\s+)?(?!\*)([^;'"]*?)\sfrom\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const clause = m[1].trim()
    const brace = clause.match(/\{([\s\S]*)\}/)
    if (!brace) continue
    const names = brace[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((raw) => {
        let text = raw
        let typeOnly = false
        if (/^type\s+/.test(text)) {
          typeOnly = true
          text = text.replace(/^type\s+/, '')
        }
        const asMatch = text.match(/^(.+?)\s+as\s+(.+)$/)
        return {
          imported: asMatch ? asMatch[1].trim() : text,
          local: asMatch ? asMatch[2].trim() : text,
          typeOnly
        }
      })
      .filter((n) => n.imported && n.imported !== 'default')
    const line = clean.slice(0, m.index).split('\n').length
    for (const n of names) out.push({ ...n, spec: m[2], line })
  }
  return out
}

/** 收集一个文件的导出名（覆盖本仓的三种导出形状；模板文本已掩码）。 */
function collectExports(code) {
  const clean = stripComments(code, { maskTemplates: true })
  const names = new Set()
  const starFrom = []
  const add = (n) => {
    if (n && n !== 'default') names.add(n)
  }
  // 导出声明：export [declare] [default] [async] [abstract] const|let|var|function|class|interface|type|enum|namespace X
  const declRe =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = declRe.exec(clean)) !== null) add(m[1])
  // export const { a, b } = slice.actions   （本仓 Redux slice 惯用法）
  const destructureRe = /\bexport\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g
  while ((m = destructureRe.exec(clean)) !== null) {
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        const asMatch = s.match(/^(.+?):\s*(.+)$/)
        add(asMatch ? asMatch[2].trim() : s.replace(/^\.\.\./, '').trim())
      })
  }
  // export { a, b as c } [from '...']
  const namedRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g
  while ((m = namedRe.exec(clean)) !== null) {
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        const asMatch = s.match(/^(.+?)\s+as\s+(.+)$/)
        add(asMatch ? asMatch[2].trim() : s.replace(/^type\s+/, '').trim())
      })
    if (m[2]) starFrom.push({ spec: m[2], namesOnly: true })
  }
  const starRe = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g
  while ((m = starRe.exec(clean)) !== null) starFrom.push({ spec: m[1], namesOnly: false })
  const hasDefault = /\bexport\s+default\b/.test(clean)
  return { names, starFrom, hasDefault }
}

/** 递归解析某个文件的全部导出名（跟随 export * 与 export { } from）。 */
function resolveExports(absFile, tables, cache = new Map(), seen = new Set()) {
  if (cache.has(absFile)) return cache.get(absFile)
  if (seen.has(absFile)) return { names: new Set(), hasDefault: false }
  seen.add(absFile)
  let code
  try {
    code = readText(absFile)
  } catch {
    return { names: new Set(), hasDefault: false }
  }
  const direct = collectExports(code)
  const names = new Set(direct.names)
  let hasDefault = direct.hasDefault
  for (const star of direct.starFrom) {
    const r = resolveSpecifier(absFile, star.spec, tables)
    if (!r.ok || !r.target) continue
    const sub = resolveExports(r.target, tables, cache, seen)
    for (const n of sub.names) names.add(n)
    if (sub.hasDefault) hasDefault = true
  }
  const result = { names, hasDefault }
  cache.set(absFile, result)
  return result
}

/** i18n 语言包。 */
function localeBundle(lang, root = REPO_ROOT) {
  return readJson(path.join(root, 'src/renderer/src/i18n/locales', `${lang}.json`))
}

/** 叶子键集合（形如 a.b.c）。 */
function leafKeys(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) leafKeys(v, key, out)
    else out.add(key)
  }
  return out
}

/** 点号取值（用于 t('a.b.c') 解析）。 */
function getDotted(obj, dotted) {
  let cur = obj
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** i18next 复数/上下文后缀（bare key 不存在但 _one/_other/_male 存在也算解析成功）。 */
const I18N_SUFFIXES = ['_one', '_other', '_zero', '_two', '_few', '_many', '_male', '_female', '_neutral']

function i18nResolves(bundle, key) {
  const hit = getDotted(bundle, key)
  if (typeof hit === 'string') return true
  for (const suffix of I18N_SUFFIXES) {
    if (typeof getDotted(bundle, key + suffix) === 'string') return true
  }
  return false
}

/** 统一的结论收集器。 */
function createReport(name) {
  return {
    name,
    failures: [],
    warnings: [],
    notes: [],
    fail(message) {
      this.failures.push(message)
    },
    warn(message) {
      this.warnings.push(message)
    },
    note(message) {
      this.notes.push(message)
    }
  }
}

/** CLI 输出 + 退出码（供各检查单独运行时使用）。 */
function reportAndExit(report) {
  const ok = report.failures.length === 0
  const lines = []
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${report.name}`)
  for (const n of report.notes) lines.push(`  note: ${n}`)
  for (const w of report.warnings) lines.push(`  warn: ${w}`)
  for (const f of report.failures) lines.push(`  FAIL: ${f}`)
  process.stdout.write(lines.join('\n') + '\n')
  process.exitCode = ok ? 0 : 1
  return ok
}

/** 各检查共用：只在这些目录里找 i18n 键字符串。 */
const I18N_SCAN_DIRS = ['src', 'packages', 'scripts']

module.exports = {
  WORKSPACE_ROOT,
  REPO_ROOT,
  IGNORED_DIRS,
  SOURCE_EXTS,
  SOURCE_ROOTS,
  I18N_SCAN_DIRS,
  walkFiles,
  walkSources,
  rel,
  readText,
  readJson,
  hasBom,
  stripComments,
  parseJsonc,
  parseSimpleYaml,
  loadAliasTable,
  aliasTables,
  aliasTableFor,
  resolveBase,
  resolveSpecifier,
  resolveSpecifierAsset,
  extractSpecifiers,
  extractNamedImports,
  collectExports,
  resolveExports,
  localeBundle,
  leafKeys,
  getDotted,
  i18nResolves,
  createReport,
  reportAndExit
}
