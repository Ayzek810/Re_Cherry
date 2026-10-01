/**
 * check-configs —— 配置文件能解析、无 BOM，且 `patches/` 与 `patchedDependencies` 维持 1:1。
 *
 * 覆盖：package.json / tsconfig*.json / .oxlintrc.json(JSONC) / biome.jsonc(JSONC) /
 *       pnpm-workspace.yaml / electron-builder.yml / pnpm-lock.yaml 的 patchedDependencies 块。
 *
 * 额外一致性（原套件"1:1 纪律"的两个真实断点都在这）：
 *   - 每个被引用的 patch 文件必须真实存在；
 *   - `pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 声明的 patch 路径集合必须一致
 *     （不同步时 pnpm 会认为 lockfile 过期，而 `--frozen-lockfile` 会直接失败）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const C = require('./lib/common')

/** 从 pnpm-lock.yaml 里抠出 patchedDependencies 块（整文件 2 万行，不整解析）。 */
function lockfilePatchedPaths(text) {
  const lines = text.split(/\r?\n/)
  const paths = []
  let inBlock = false
  let blockIndent = -1
  for (const raw of lines) {
    if (!raw.trim()) continue
    const indent = raw.match(/^\s*/)[0].length
    if (!inBlock) {
      if (/^patchedDependencies:\s*$/.test(raw)) {
        inBlock = true
        blockIndent = indent
      }
      continue
    }
    if (indent <= blockIndent) break // 块结束
    const m = raw.match(/^\s*path:\s*(.+?)\s*$/)
    if (m) paths.push(m[1].replace(/^['"]|['"]$/g, ''))
  }
  return paths
}

function run() {
  const report = C.createReport('check-configs')
  const root = C.REPO_ROOT
  const jsonFiles = [
    'package.json',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    '.oxlintrc.json',
    'biome.jsonc'
  ]
  const yamlFiles = ['pnpm-workspace.yaml', 'electron-builder.yml']

  // 1. 可解析 + 无 BOM
  for (const name of jsonFiles) {
    const abs = path.join(root, name)
    try {
      C.parseJsonc(C.readText(abs))
    } catch (error) {
      report.fail(`${name} 解析失败: ${error.message}`)
    }
    if (C.hasBom(abs)) report.fail(`${name} 带 UTF-8 BOM（会破坏 JSON.parse / 工具链）`)
  }
  for (const name of yamlFiles) {
    const abs = path.join(root, name)
    if (C.hasBom(abs)) report.fail(`${name} 带 UTF-8 BOM`)
    const parsed = C.parseSimpleYaml(C.readText(abs))
    if (!parsed || Object.keys(parsed).length === 0) report.fail(`${name} 解析不出任何顶层键`)
  }

  // 2. patches/ ↔ patchedDependencies 1:1
  const workspaceYaml = C.parseSimpleYaml(C.readText(path.join(root, 'pnpm-workspace.yaml')))
  const declared = workspaceYaml.patchedDependencies || {}
  const declaredPaths = Object.values(declared).filter((v) => typeof v === 'string')
  const dirEntries = fs.readdirSync(path.join(root, 'patches')).filter((f) => f.endsWith('.patch'))
  const declaredNames = declaredPaths.map((p) => path.basename(p)).sort()
  const dirNames = [...dirEntries].sort()

  if (JSON.stringify(declaredNames) !== JSON.stringify(dirNames)) {
    const onlyDeclared = declaredNames.filter((n) => !dirNames.includes(n))
    const onlyDir = dirNames.filter((n) => !declaredNames.includes(n))
    report.fail(
      `patches/ 与 patchedDependencies 不是 1:1（声明 ${declaredNames.length} / 目录 ${dirNames.length}）` +
        (onlyDeclared.length ? ` 仅声明: ${onlyDeclared.join(', ')}` : '') +
        (onlyDir.length ? ` 仅在目录: ${onlyDir.join(', ')}` : '')
    )
  }
  for (const p of declaredPaths) {
    if (!fs.existsSync(path.join(root, p))) report.fail(`patchedDependencies 指向的文件不存在: ${p}`)
  }
  report.note(`patches 1:1 通过：${declaredNames.length} 个（${declaredNames.join(', ')}）`)

  // 3. lockfile 的 patchedDependencies 必须与 workspace 一致
  const lockPaths = lockfilePatchedPaths(C.readText(path.join(root, 'pnpm-lock.yaml')))
  const lockNames = lockPaths.map((p) => path.basename(p)).sort()
  if (JSON.stringify(lockNames) !== JSON.stringify(declaredNames)) {
    report.fail(
      `pnpm-lock.yaml 的 patchedDependencies 与 pnpm-workspace.yaml 不一致：` +
        `lock=[${lockNames.join(', ')}] workspace=[${declaredNames.join(', ')}]（需 pnpm install 重算 lockfile）`
    )
  } else {
    report.note(`lockfile patchedDependencies 与 workspace 一致（${lockNames.length} 个）`)
  }

  // 4. 版本与 engines 基本形态
  const pkg = C.readJson(path.join(root, 'package.json'))
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version))) report.fail(`package.json version 形态异常: ${pkg.version}`)
  if (!pkg.packageManager) report.fail('package.json 缺 packageManager（pnpm 版本会被漂移）')
  report.note(`version=${pkg.version} packageManager=${pkg.packageManager}`)

  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
