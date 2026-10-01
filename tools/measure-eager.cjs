// measure-eager.cjs — read-only first-paint payload meter for the Re_Cherry renderer build.
//
// Usage: node tools/measure-eager.cjs [repoRoot] [--json]
//
// The repository root defaults to the directory this file lives in (walked up to the one that
// holds package.json + src/main), so the meter runs from any checkout or copy. Pass a path or
// set RC_REPO to override it.
//
// Two faces are reported, because they answer two different questions:
//
//   FACE A  "preload face"  = every asset named by index.html (entry script + modulepreload
//                             links + stylesheets). This is what the browser *fetches* for the
//                             first paint. Vite writes a modulepreload hint for chunks that only
//                             a dynamic import needs, so this face can contain lazy chunks.
//   FACE B  "executed closure" = static-import closure of the entry script. This is what the
//                             browser must *parse and execute* before the first paint.
//
// FACE B is the number that moves when a static value import becomes a dynamic import.
// FACE A is the number that moves when a chunk leaves the modulepreload list.
const fs = require('node:fs')
const path = require('node:path')

/** Repository root: walk up from this file to the directory that holds package.json + src/main. */
function findRepoRoot(start) {
  let dir = start
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src', 'main'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`measure-eager: cannot locate the repository root above ${start}`)
}

const argRoot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
const root = argRoot ?? (process.env.RC_REPO ? path.resolve(process.env.RC_REPO) : findRepoRoot(__dirname))
const outDir = path.join(root, 'out', 'renderer')
const assetsDir = path.join(outDir, 'assets')

if (!fs.existsSync(assetsDir)) {
  console.error(`measure-eager: no renderer build at ${assetsDir} — build first (pnpm build, or electron-vite build).`)
  process.exit(1)
}

const files = fs.readdirSync(assetsDir)
const size = new Map()
const text = new Map()
for (const f of files) {
  const p = path.join(assetsDir, f)
  const st = fs.statSync(p)
  size.set(f, st.size)
  if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.css')) text.set(f, fs.readFileSync(p, 'utf8'))
}

const staticDeps = new Map()
const dynDeps = new Map()
function add(map, from, to) {
  if (!to || to === from) return
  if (!size.has(to)) return
  let s = map.get(from)
  if (!s) map.set(from, (s = new Set()))
  s.add(to)
}
const stripQuery = (s) => s.split('?')[0].split('#')[0]
for (const [f, src] of text) {
  for (const m of src.matchAll(/\bfrom\s*"\.\/([^"]+)"/g)) add(staticDeps, f, stripQuery(m[1]))
  for (const m of src.matchAll(/\bimport\s*"\.\/([^"]+)"/g)) add(staticDeps, f, stripQuery(m[1]))
  for (const m of src.matchAll(/m\.f\s*=\s*m\.f\s*\|\|\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/"\.\/([^"]+)"/g)) add(dynDeps, f, stripQuery(q[1]))
  }
  for (const m of src.matchAll(/d\s*=\s*\(\s*m\.f\s*\|\|\s*\(\s*m\.f\s*=\s*\[([^\]]*)\]\s*\)\s*\)/g)) {
    for (const q of m[1].matchAll(/"\.\/([^"]+)"/g)) add(dynDeps, f, stripQuery(q[1]))
  }
}

function htmlFace(htmlName) {
  const htmlPath = path.join(outDir, htmlName)
  if (!fs.existsSync(htmlPath)) return null
  const html = fs.readFileSync(htmlPath, 'utf8')
  const refs = new Set()
  for (const m of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)) refs.add(m[1])
  return refs
}

function closureOf(entry) {
  const seen = new Set()
  const q = entry ? [entry] : []
  while (q.length) {
    const f = q.shift()
    if (seen.has(f) || !size.has(f)) continue
    seen.add(f)
    for (const d of staticDeps.get(f) || []) if (!seen.has(d)) q.push(d)
  }
  return seen
}

const sum = (set) => [...set].reduce((a, f) => a + (size.get(f) || 0), 0)
const mb = (n) => (n / 1048576).toFixed(3)
const kb = (n) => (n / 1024).toFixed(1)

const report = {
  root,
  windows: {},
  assets: { count: files.length, bytes: [...size.values()].reduce((a, b) => a + b, 0) }
}

// Full chunk lists per window, so an A/B run can diff tiers without a shell one-liner.
for (const [windowName, htmlName] of [
  ['main', 'index.html'],
  ['mini', 'miniWindow.html'],
  ['trace', 'traceWindow.html']
]) {
  const face = htmlFace(htmlName)
  if (!face) continue
  const entry = [...face].find((f) => /^index-.*\.js$/.test(f)) || [...face].find((f) => /^miniWindow-.*\.js$/.test(f))
  report[`${windowName}__preloadFace`] = [...face].sort()
  report[`${windowName}__executedClosure`] = [...closureOf(entry)].sort()
}

for (const [windowName, htmlName] of [
  ['main', 'index.html'],
  ['mini', 'miniWindow.html'],
  ['trace', 'traceWindow.html']
]) {
  const face = htmlFace(htmlName)
  if (!face) continue
  const entry = [...face].find((f) => /^index-.*\.js$/.test(f)) || [...face].find((f) => /^miniWindow-.*\.js$/.test(f))
  const closure = closureOf(entry)
  const union = new Set([...face, ...closure])
  const lazyAlsoPreloaded = [...face].filter((f) => !closure.has(f)).length
  report.windows[windowName] = {
    preloadFace: { chunks: face.size, bytes: sum(face) },
    executedClosure: { chunks: closure.size, bytes: sum(closure) },
    union: { chunks: union.size, bytes: sum(union) },
    preloadOnlyChunks: lazyAlsoPreloaded,
    top: [...union]
      .map((f) => ({ f, s: size.get(f) || 0, kind: closure.has(f) ? 'static' : 'preload' }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
  }
}

report.duplicateLanguageChunks = (() => {
  const byLang = new Map()
  for (const f of files) {
    const m = /^([a-z0-9-]+)-[A-Za-z0-9_-]{8}\.js$/.exec(f)
    if (!m) continue
    const lang = m[1]
    if (
      !/^(emacs-lisp|cpp|wasm|wolfram|typescript|jsx|tsx|javascript|angular-ts|vue-vine|mdx|asciidoc|php|less|scss|css|html|python|java|json|markdown|xml)$/.test(
        lang
      )
    )
      continue
    let arr = byLang.get(lang)
    if (!arr) byLang.set(lang, (arr = []))
    arr.push({ f, s: size.get(f) || 0 })
  }
  const pairs = []
  let wasted = 0
  for (const [lang, arr] of byLang) {
    if (arr.length < 2) continue
    arr.sort((a, b) => b.s - a.s)
    // Same language grammar compiled to two near-equal chunks = one unreachable duplicate.
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].s > 1024) wasted += arr[i].s
    }
    pairs.push({
      lang,
      chunks: arr.map((x) => `${x.f} ${x.s}`),
      duplicateBytes: arr.slice(1).reduce((a, x) => a + x.s, 0)
    })
  }
  pairs.sort((a, b) => b.duplicateBytes - a.duplicateBytes)
  return { totalDuplicateBytes: wasted, pairs }
})()

// Named assets the audit reports track by content, not by hash (Vite hashes are not reproducible
// across runs on this toolchain, so an A/B run must compare bytes, never filenames).
report.namedAssets = (() => {
  const patterns = {
    store: /^store-/,
    katexEngine: /^katex-[A-Za-z0-9_-]+\.js$/,
    markdownIt: /^markdown-it-[A-Za-z0-9_-]+\.js$/,
    rehypeKatex: /^rehype-katex-/,
    shikiCore: null, // identified by content, below
    dndKit: /^dnd\.esm-/
  }
  const of = (re) => (re ? files.filter((f) => re.test(f)).map((f) => ({ f, s: size.get(f) || 0 })) : [])
  const shikiCore = []
  for (const [f, src] of text) {
    // `getTokenStyleObject as h` is part of the @shikijs/core export surface.
    if (src.includes('getTokenStyleObject as h') && /^dist-.*\.js$/.test(f)) shikiCore.push({ f, s: size.get(f) || 0 })
  }
  return {
    store: of(patterns.store),
    katexEngine: of(patterns.katexEngine),
    markdownIt: of(patterns.markdownIt),
    rehypeKatex: of(patterns.rehypeKatex),
    shikiCore,
    dndKit: of(patterns.dndKit)
  }
})()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`repo: ${root}`)
  console.log(`assets: ${report.assets.count} files, ${mb(report.assets.bytes)} MB raw`)
  for (const [name, w] of Object.entries(report.windows)) {
    console.log('')
    console.log(`--- window: ${name} ---`)
    console.log(
      `  FACE A preload face      : ${String(w.preloadFace.chunks).padStart(4)} chunks, ${mb(w.preloadFace.bytes).padStart(8)} MB (${w.preloadFace.bytes} B)`
    )
    console.log(
      `  FACE B executed closure  : ${String(w.executedClosure.chunks).padStart(4)} chunks, ${mb(w.executedClosure.bytes).padStart(8)} MB (${w.executedClosure.bytes} B)`
    )
    console.log(
      `  FACE A∪B union           : ${String(w.union.chunks).padStart(4)} chunks, ${mb(w.union.bytes).padStart(8)} MB (${w.union.bytes} B)`
    )
    console.log(`  preload-only chunks (hint, not executed): ${w.preloadOnlyChunks}`)
    console.log(`  top 20:`)
    for (const r of w.top) console.log(`    ${mb(r.s).padStart(8)} MB  ${r.kind.padEnd(7)} ${r.f}`)
  }
  console.log('')
  console.log(`--- named assets (content-tracked, hash-independent) ---`)
  for (const [name, arr] of Object.entries(report.namedAssets)) {
    const total = arr.reduce((a, x) => a + x.s, 0)
    console.log(
      `  ${name.padEnd(14)} total=${String(total).padStart(9)} B   ${arr.map((x) => `${x.f}(${x.s})`).join(' ') || '-'}`
    )
  }
  console.log('')
  console.log(`--- duplicate language chunks ---`)
  console.log(
    `  total duplicate bytes: ${report.duplicateLanguageChunks.totalDuplicateBytes} (${mb(report.duplicateLanguageChunks.totalDuplicateBytes)} MB)`
  )
  for (const p of report.duplicateLanguageChunks.pairs.slice(0, 20)) {
    console.log(`  ${p.lang.padEnd(14)} dup=${kb(p.duplicateBytes).padStart(9)} KB   ${p.chunks.join(' | ')}`)
  }
}
