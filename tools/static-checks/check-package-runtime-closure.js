/**
 * check-package-runtime-closure —— 打包运行期闭包：安装版里“谁能 import 谁”必须闭合。
 *
 * 背景（事故）：electron-builder 从根 package.json 的生产依赖出发，只沿
 * **正则 dependencies 边**收集闭包进 app.asar；pnpm autoInstallPeers 在 dev/测试下用
 * .pnpm 虚拟目录满足纯粹的 peer 依赖。于是“包 X 只以 peer 形态被运行期需要”时：
 * dev 全绿、打包成功、安装版启动即 ERR_MODULE_NOT_FOUND——三重绿灯全盲。
 *
 * 判定：模拟 electron-builder 的收集（根 dependencies∪optionalDependencies 起步、
 * 沿正则边 BFS），对收集集中**每个**包的全部运行期边（dependencies + peerDependencies，
 * 非 optional）做扁平树可解析校验——目标必须也在收集集内。缺哪个名字，哪个名字就会在
 * 安装版里炸；修复形态永远是“在根 package.json 显式声明它”。
 *
 * 需要 node_modules/.pnpm（未安装时自跳过，同 check-upstream 无参考树的处理）。
 * 时机：凡改 package.json 依赖、升级内核包族、或打出安装包之前，必须跑。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const C = require('./lib/common')

/**
 * 已知豁免的边目标（有理由才准进，注明日期与原因）：
 * （暂无——出现新豁免必须在版本报告里记 why）
 */
const EXEMPT_EDGE_TARGETS = new Set([
  // 2026-09-24 ：elysia 的两个纯类型 peer。
  // - openapi-types：纯 .d.ts 包（无任何运行期 JS），仅满足 tsc；electron-builder 不需要。
  // - typescript：仅 @elysia/openapi 的 gen 子模块在"从 TS import() 类型引用生成 schema"
  //   时惰性 require（缺省时有优雅报错引导 dev 安装）；本仓路由全部用 zod schema，
  //   不触发该路径。V2 生产版同样不随包分发 typescript（其 package.json 中 typescript 在
  //   devDependencies）——行为已在上游验证。真正的运行期校验核心 @sinclair/typebox
  //   不豁免，已显式声明进根 dependencies。
  'openapi-types',
  'typescript'
])

function run() {
  const report = C.createReport('check-package-runtime-closure')
  const nmRoot = path.join(C.REPO_ROOT, 'node_modules')
  const pnpmRoot = path.join(nmRoot, '.pnpm')

  if (!fs.existsSync(pnpmRoot)) {
    report.note('node_modules/.pnpm 不存在——自跳过（本检查需要已安装的依赖树）')
    return report
  }

  const pkg = C.readJson(path.join(C.REPO_ROOT, 'package.json'))
  const roots = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})])

  const pnpmDirs = fs
    .readdirSync(pnpmRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(pnpmRoot, d.name))

  const manifestCache = new Map()
  /** 解析包 manifest：先走顶层（pnpm 的 junction），再沿 .pnpm 各虚拟目录的 junction（pnpm 自身的解析方式）。 */
  function manifestOf(name) {
    if (manifestCache.has(name)) return manifestCache.get(name)
    let m = null
    const topP = path.join(nmRoot, name, 'package.json')
    try {
      m = JSON.parse(fs.readFileSync(topP, 'utf8'))
    } catch {
      m = null
    }
    if (!m) {
      for (const dir of pnpmDirs) {
        const p = path.join(dir, 'node_modules', name, 'package.json')
        try {
          m = JSON.parse(fs.readFileSync(p, 'utf8'))
          break
        } catch {
          /* 下一个虚拟目录 */
        }
      }
    }
    manifestCache.set(name, m)
    return m
  }

  // 1. 收集：electron-builder 集合的近似（正则边 BFS；optional 缺席不算失败）
  const collected = new Map()
  const queue = []
  for (const name of roots) queue.push({ name, optional: true })
  const unresolvableRequired = []
  let visited = new Set()
  while (queue.length > 0) {
    const { name, optional } = queue.shift()
    if (visited.has(name)) continue
    visited.add(name)
    const m = manifestOf(name)
    if (!m) {
      if (!optional) unresolvableRequired.push(name)
      continue
    }
    collected.set(name, m)
    const regularDeps = [...Object.keys(m.dependencies || {}), ...Object.keys(m.optionalDependencies || {})]
    for (const dep of regularDeps) {
      if (!visited.has(dep)) queue.push({ name: dep, optional: (m.optionalDependencies || {})[dep] !== undefined })
    }
  }

  for (const name of unresolvableRequired) report.fail(`正则依赖在磁盘上解析不到: ${name}`)

  // 2. 闭包校验：收集集内每个包的运行期边（deps+peers，非 optional）必须仍在集合内
  const missing = []
  let edgeCount = 0
  for (const [name, m] of collected) {
    const edges = new Set([...Object.keys(m.dependencies || {}), ...Object.keys(m.peerDependencies || {})])
    for (const dep of edges) {
      edgeCount += 1
      if (collected.has(dep) || roots.has(dep) || EXEMPT_EDGE_TARGETS.has(dep)) continue
      const optional =
        (m.optionalDependencies || {})[dep] !== undefined || m.peerDependenciesMeta?.[dep]?.optional === true
      if (optional) continue
      missing.push(`${name} needs ${dep}`)
    }
  }

  report.note(`收集 ${collected.size} 个包，运行期边 ${edgeCount} 条（electron-builder 只带正则边，peer 需根声明）`)
  if (missing.length === 0) {
    report.note('闭包完整：全部 dependencies+peerDependencies 在打包集合内扁平可解析')
  } else {
    const names = new Set(missing.map((x) => x.split(' needs ')[1]))
    report.fail(
      `${missing.length} 条运行期边无法解析，涉及 ${names.size} 个包（安装版会 ERR_MODULE_NOT_FOUND）。` +
        `修复：在根 package.json dependencies 显式声明—— ${[...names].sort().join(', ')}`
    )
    for (const x of missing) report.fail(`  ${x}`)
  }

  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
