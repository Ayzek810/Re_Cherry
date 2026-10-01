// 首屏载荷前后对照测量（只读）。
// 用法: node tools/audit2-fixes/measure-eager.cjs
// 口径与 E:\Workspace\project_REC\tools\audit2-eager-graph.cjs 的 TIER1/TIER1b 一致：
//   TIER1  = index.html 里 script/modulepreload/stylesheet 直接引用的资源总体积
//   TIER1b = 入口脚本静态 import 闭包
// 另打印 store-*.js 与本轮新增懒 chunk 的体积，供 reports/audit2-fixes/performance.md 引用。
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2] || 'E:\\Workspace\\project_REC\\Re_Cherry'
const outDir = path.join(root, 'out', 'renderer')
const assetsDir = path.join(outDir, 'assets')

const files = fs.readdirSync(assetsDir)
const size = new Map()
const text = new Map()
for (const f of files) {
  const p = path.join(assetsDir, f)
  size.set(f, fs.statSync(p).size)
  if (f.endsWith('.js') || f.endsWith('.css')) text.set(f, fs.readFileSync(p, 'utf8'))
}

const staticDeps = new Map()
const add = (from, to) => {
  if (!to || to === from || !size.has(to)) return
  let s = staticDeps.get(from)
  if (!s) staticDeps.set(from, (s = new Set()))
  s.add(to)
}
for (const [f, src] of text) {
  for (const m of src.matchAll(/\bfrom\s*"\.\/([^"]+)"/g)) add(f, m[1].split('?')[0])
  for (const m of src.matchAll(/\bimport\s*"\.\/([^"]+)"/g)) add(f, m[1].split('?')[0])
}

const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')
const refs = new Set()
for (const m of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)) refs.add(m[1])
const entry = [...refs].find((f) => /^index-.*\.js$/.test(f))
const closure = new Set()
{
  const q = entry ? [entry] : []
  while (q.length) {
    const f = q.shift()
    if (closure.has(f) || !size.has(f)) continue
    closure.add(f)
    for (const d of staticDeps.get(f) || []) if (!closure.has(d)) q.push(d)
  }
}

const mb = (n) => (n / 1048576).toFixed(3)
const sum = (set) => [...set].reduce((a, f) => a + (size.get(f) || 0), 0)

console.log(`repo: ${root}`)
console.log(`assets: ${files.length} files, ${mb([...size.values()].reduce((a, b) => a + b, 0))} MB raw`)
console.log(`TIER1  index.html preload face     : ${refs.size} chunks, ${sum(refs)} B (${mb(sum(refs))} MB)`)
console.log(`TIER1b entry static-import closure : ${closure.size} chunks, ${sum(closure)} B (${mb(sum(closure))} MB)`)
for (const pattern of [/^store-.*\.js$/, /^exportBackends-.*\.js$/, /^katex-.*\.js$/]) {
  const hit = files.filter((f) => pattern.test(f))
  for (const f of hit)
    console.log(`  ${f.padEnd(36)} ${String(size.get(f)).padStart(10)} B  eager=${refs.has(f) || closure.has(f)}`)
}
