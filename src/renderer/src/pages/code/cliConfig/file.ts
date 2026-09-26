// fork 移植自 cherry-studio v2 src/renderer/pages/code/cliConfig/file.ts（2026-09-24，v0.3.4-1 批次4a）。
// 缝点三处，已标 `// fork 缝`：
// ① ipc 缝：V2 `ipcApi.request('code_cli.read_config', …)` → fork `window.api.codeCli.readConfig`
//   （直连通道，主进程 ipc.ts 白名单校验 target 后经 readCliConfigFiles 读盘）。
// ② 类型缝：V2 `OutputFor<'code_cli.read_config'>` 由 zod 路由 schema 推导；fork 无 schema 层，
//   按 V2 该路由的输出形状手写（{path, content}，content === null ⇔ 文件不存在）。
// ③ 依赖缝：smol-toml 未随 fork 安装（fork 目标表仅 hermes 两 target，yaml+dotenv，TOML 臂
//   运行期不可达）；CliConfigLanguage 联合保形，parseTomlOrThrow 显式抛错。

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { type Document, isMap, isScalar, parse as parseYaml, parseDocument } from 'yaml'

import type { CliConfigTarget } from '@shared/utils/cliConfig'
import { redactSecretText } from '@shared/utils/redaction'

/** One CLI config file as read through `code_cli.read_config`: content === null ⇔ the file does not exist. */
// fork 缝②：V2 为 `Pick<OutputFor<'code_cli.read_config'>['files'][number], 'path' | 'content'>`。
export type CliConfigReadFile = { path: string; content: string | null }

/** On-disk view of a batch read, keyed by target. */
export type CliConfigReadFiles = Map<CliConfigTarget, CliConfigReadFile>

/**
 * Batch-read CLI config files through the target-enum IPC route (one round trip
 * per batch; main resolves each target's absolute path).
 */
export async function readConfigFiles(targets: readonly CliConfigTarget[]): Promise<CliConfigReadFiles> {
  if (!targets.length) return new Map()
  // fork 缝①：V2 为 `await ipcApi.request('code_cli.read_config', { targets: [...targets] })`；
  // fork 桥接层入参/返回均为 unknown（校验在主进程 ipc.ts），此处按②的手写形状收窄。
  const result = (await window.api.codeCli.readConfig({ targets: [...targets] })) as {
    files: Array<{ target: CliConfigTarget; path: string; content: string | null }>
  }
  return new Map(result.files.map((file) => [file.target, file]))
}

/** The read entry for `target`; a missing entry is a caller bug (readConfigFiles returns every requested target). */
export function requireReadFile(target: CliConfigTarget, files: CliConfigReadFiles): CliConfigReadFile {
  const file = files.get(target)
  if (!file) throw new Error(`No read result for config target: ${target}`)
  return file
}

function parseOrThrow<T>(content: string, label: string, absPath: string, parseFn: (content: string) => T): T {
  try {
    return parseFn(content)
  } catch (err) {
    // Safe to embed: parseTomlOrThrow redacts its message at the source, and
    // parseJsonOrThrow's messages carry no file content (only an error count) —
    // if it ever starts embedding source, it must redact like the TOML parser.
    const rawMessage = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse ${label} at ${absPath}: ${rawMessage}`)
  }
}

/** Parse JSONC from a batch read; returns null (not {}) when the file doesn't exist. */
export function readValidatedJsonOrNull(
  target: CliConfigTarget,
  files: CliConfigReadFiles,
  label: string
): Record<string, any> | null {
  const { path, content } = requireReadFile(target, files)
  return content === null ? null : parseOrThrow(content, label, path, parseJsonOrThrow)
}

/** Parse TOML from a batch read; returns null (not {}) when the file doesn't exist. */
export function readValidatedTomlOrNull(
  target: CliConfigTarget,
  files: CliConfigReadFiles,
  label: string
): Record<string, any> | null {
  const { path, content } = requireReadFile(target, files)
  return content === null ? null : parseOrThrow(content, label, path, parseTomlOrThrow)
}

// fork 缝③：V2 用 smol-toml 逐字解析；fork 未安装该包（hermes 两 target 无 TOML）。
export function parseTomlOrThrow(content: string): Record<string, any> {
  if (!content) return {}
  throw new Error('TOML CLI config targets are not ported in this fork')
}

export function parseYamlOrThrow(content: string): Record<string, any> {
  if (!content) return {}
  try {
    const parsed = parseYaml(content)
    if (parsed == null) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid YAML root: expected an object')
    }
    return parsed as Record<string, any>
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    throw new Error(redactSecretText(rawMessage))
  }
}

/** Parse a user-owned YAML mapping without discarding its comments or presentation. */
export function parseYamlDocumentOrThrow(content: string): Document {
  try {
    const document = parseDocument(content)
    if (document.errors.length > 0) throw document.errors[0]
    const root = document.contents
    if (root === null || (isScalar(root) && root.value === null)) {
      const mapping = document.createNode({})
      if (root && isScalar(root)) {
        mapping.comment = root.comment
        mapping.commentBefore = root.commentBefore
      }
      document.contents = mapping as unknown as typeof document.contents
    }
    if (!isMap(document.contents)) throw new Error('invalid YAML root: expected an object')
    return document
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    throw new Error(redactSecretText(rawMessage))
  }
}

export function parseJsonOrThrow(content: string): Record<string, any> {
  if (!content) return {}
  const errors: ParseError[] = []
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    throw new Error(`invalid JSONC (${errors.length} parse error(s))`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid JSONC root: expected an object')
  }
  return parsed as Record<string, any>
}

export function renderJsonFile(value: Record<string, any>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
