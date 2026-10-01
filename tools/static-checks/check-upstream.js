/**
 * check-upstream —— 与上游参考树逐条对账（本仓是派生版，**非预期分叉**是最大回归风险）。
 *
 * 为什么需要它：后续批次里发现的两类真实损伤（`SUPPORT_URL_CONTEXT_PROVIDER_TYPES`
 * 少了 gemini/vertexai/azure-openai、`NOT_SUPPORT_API_KEY_PROVIDER_TYPES` 被清空）**都是靠人肉
 * 拿 fork 与上游对账**找出来的——机器门禁当时完全看不见。本检查把那次对账固化成可重复执行的检查。
 *
 * 规则来自 `upstream-policy.json`（每条必须写 why）：
 *   - `equal`：条目集合必须与上游一致（按 ProviderType 索引的列表属于此类：类型仍合法，
 *     条目不应随系统 provider 下线而裁剪）；
 *   - `subset-of-upstream`：允许比上游少（按 SystemProviderId 索引的列表：provider 下线时少条目是对的），
 *     但**不允许出现上游没有的条目**。
 *
 * 上游参考树缺失时**整体跳过**（记 note，不判失败）——套件必须在没有 `参考资产/` 的机器上也能跑。
 * 指定方式：`--upstream=<路径>` / 环境变量 `RC_UPSTREAM`；默认取 `upstream-policy.json` 的 upstreamDefault
 * （相对工作区根，即 `参考资产/cherry-studio v1.9.11`）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const C = require('./lib/common')

const POLICY = path.join(__dirname, 'upstream-policy.json')

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY, 'utf8'))
}

function resolveUpstreamRoot(policy) {
  const fromArg = (process.argv.find((a) => a.startsWith('--upstream=')) || '').slice('--upstream='.length)
  const explicit = fromArg || process.env.RC_UPSTREAM
  if (explicit) return path.resolve(explicit)
  return path.join(C.WORKSPACE_ROOT, policy.upstreamDefault)
}

/**
 * 抽出 `const NAME = [...]`（含 export / 类型注解 / as const satisfies 形态）的数组字面量内容。
 *
 * 用**括号配平**扫描而非非贪婪正则：`SystemProviderIds['azure-openai']` 这类条目内部自带 `]`，
 * 非贪婪 `\[([\s\S]*?)\]` 会在它那里提前截断（首版就是这么错的——把 azure-openai 截成
 * "SystemProviderIds['azure-openai'" 并连带误报 groq 为"上游没有的条目"）。
 * 局限：不处理字符串字面量里的方括号（本表用途下不会出现）。
 */
function extractArrayLiteral(source, constant) {
  const declRe = new RegExp(`(?:export\\s+)?const\\s+${constant}\\s*(?::[^=]*)?=\\s*\\[`)
  const match = declRe.exec(source)
  if (!match) return null
  const start = match.index + match[0].length - 1 // 指向 '['
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  return null
}

/** 归一化一个条目：'x' | "x" | SystemProviderIds.x | SystemProviderIds['x'] → x。 */
function normalizeEntry(raw) {
  let text = raw
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
  if (text === '') return null
  const bracket = text.match(/^SystemProviderIds\[\s*['"]([^'"]+)['"]\s*\]$/)
  if (bracket) return bracket[1]
  const dotted = text.match(/^SystemProviderIds\.([A-Za-z_$][\w$]*)$/)
  if (dotted) return dotted[1]
  const quoted = text.match(/^['"]([^'"]+)['"]$/)
  if (quoted) return quoted[1]
  return { unrecognized: text }
}

function parseEntries(body) {
  const entries = []
  const unrecognized = []
  for (const raw of body.split(',')) {
    const normalized = normalizeEntry(raw)
    if (normalized === null) continue
    if (typeof normalized === 'object') unrecognized.push(normalized.unrecognized)
    else entries.push(normalized)
  }
  return { entries, unrecognized }
}

function run() {
  const report = C.createReport('check-upstream')
  const policy = loadPolicy()
  const upstreamRoot = resolveUpstreamRoot(policy)

  if (!fs.existsSync(upstreamRoot)) {
    report.note(`上游参考树不存在，本项跳过：${upstreamRoot}（用 --upstream=<路径> 或 RC_UPSTREAM 指定）`)
    return report
  }
  report.note(`上游参考树：${upstreamRoot}（${policy.upstreamVersionLabel}）`)

  let compared = 0
  for (const pair of policy.pairs) {
    const forkPath = path.join(C.REPO_ROOT, pair.file)
    const upstreamPath = path.join(upstreamRoot, pair.file)
    if (!fs.existsSync(forkPath) || !fs.existsSync(upstreamPath)) {
      report.warn(
        `文件缺失，跳过：${pair.file}（fork=${fs.existsSync(forkPath)} upstream=${fs.existsSync(upstreamPath)}）`
      )
      continue
    }
    const forkBody = extractArrayLiteral(fs.readFileSync(forkPath, 'utf8'), pair.constant)
    const upstreamBody = extractArrayLiteral(fs.readFileSync(upstreamPath, 'utf8'), pair.constant)
    if (forkBody === null) {
      report.fail(`fork 里找不到常量 ${pair.constant}（${pair.file}）—— 是被改名/删除，还是本检查的正则过时？`)
      continue
    }
    if (upstreamBody === null) {
      report.warn(`上游里找不到常量 ${pair.constant}（${pair.file}）—— 上游可能已改名，请复核策略表`)
      continue
    }

    const fork = parseEntries(forkBody)
    const upstream = parseEntries(upstreamBody)
    compared += 1
    for (const weird of fork.unrecognized) report.warn(`${pair.constant}：fork 里有未识别条目形态 "${weird}"`)
    for (const weird of upstream.unrecognized) report.warn(`${pair.constant}：上游里有未识别条目形态 "${weird}"`)

    const missing = upstream.entries.filter((e) => !fork.entries.includes(e))
    const extra = fork.entries.filter((e) => !upstream.entries.includes(e))

    if (pair.rule === 'equal') {
      if (missing.length > 0) {
        report.fail(`${pair.constant}：比上游少 [${missing.join(', ')}]（规则 equal；${pair.why}）`)
      }
      if (extra.length > 0) {
        report.fail(`${pair.constant}：比上游多 [${extra.join(', ')}]（规则 equal；${pair.why}）`)
      }
    } else if (pair.rule === 'subset-of-upstream') {
      if (extra.length > 0) {
        report.fail(
          `${pair.constant}：出现上游没有的条目 [${extra.join(', ')}]（规则 subset-of-upstream；${pair.why}）`
        )
      }
      if (missing.length > 0) {
        report.note(`${pair.constant}：比上游少 [${missing.join(', ')}]（规则允许；${pair.why}）`)
      }
    } else {
      report.warn(`未知规则 "${pair.rule}"（${pair.constant}），已跳过比对`)
    }
  }

  report.note(`已比对 ${compared}/${policy.pairs.length} 个常量（规则与理由见 upstream-policy.json）`)
  return report
}

module.exports = { run }
if (require.main === module) C.reportAndExit(run())
