/**
 * 自 CS_V1 移植 + 裁剪清单。
 *
 * 自 CS_V1 src/main/utils/process.ts 的 findCommandInShellEnv 移植（fork 主进程 utils
 * 无该工具，按 范围收纳于 services/mcp/ 下）。
 *
 * 适配：CS_V1 传入登录 shell 环境（getLoginShellEnvironment，macOS/Linux GUI 应用
 * 不继承 shell PATH 才需要）；fork MVP 直接快照 process.env 作为查找与子进程环境。
 *
 * 裁剪：bundled binary 兜底（isBinaryExists/getBinaryPath）不在本文件——双缺时由
 * MCPService 抛出引导安装 Node.js/uv 的错误文案；findExecutable/findViaMise 等其余
 * process.ts 工具未移植。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
// 具名导入 resolve：`path` 默认导出在部分测试的模块桩里只替换 join/resolve，
// 而"绝对路径归一化"是安全判定的一部分，必须走真实实现。
import path, { resolve as resolvePath } from 'node:path'

import { loggerService } from '@logger'
import { killProcessTree } from '@main/utils/processRunner'

const logger = loggerService.withContext('MCPService:commandResolution')

const isWin = process.platform === 'win32'

// 命令查找超时（毫秒）
const COMMAND_LOOKUP_TIMEOUT_MS = 5000

// 命令名校验：仅字母数字/下划线/连字符，防命令注入
const VALID_COMMAND_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/

// 输出上限，防缓冲区溢出（10KB）
const MAX_OUTPUT_SIZE = 10240

/**
 * 绝对路径命令的可用扩展名（仅 Windows）。`.cmd`/`.bat` 由 cross-spawn 转发，
 * MCP SDK 的 StdioClientTransport 内部同样用 cross-spawn（`shell: false` 但带
 * `.cmd` 转发），故这两类是可执行入口，不再是"未找到"。
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat']

/**
 * shell 元字符与引号：这些字符会让 `cmd.exe` 上的 `%VAR%` 展开、`&`/`|` 串联、
 * 引号改变解析边界。裸名与绝对路径都一律拒绝——路径里合法出现它们的可能性远低于
 * 被当成注入面的代价。空白字符同样在内：`node -e 1` 这类"命令 + 参数"值必须整体拒绝。
 */
const SHELL_METACHARACTER_REGEX = /[\s&|<>^%!;"'`$(){}[\]]/

/** 快照 process.env 为 Record<string, string>（过滤 undefined），可再叠加服务器私有 env。
 * StdioClientTransport 的 env 参数要求 Record<string, string>。
 */
export function getInheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[key] = value
    }
  }
  return { ...inherited, ...extra }
}

/**
 * MCP `server.command` 进 `StdioClientTransport` 之前的准入校验。
 *
 * `MCPService.initTransport` 此前只在 `npx`/`uvx`/`uv` 三条分支走 `findCommandInShellEnv`
 * （注入面收在那里），其余情况直接 spawn 渲染层给的任意字符串——`C:\evil.exe`、
 * `node -e "..."` 都能落进 `command`。本函数把注入面收敛到真正 spawn 的那一处：
 *
 * - 裸命令名（无路径分隔符）：必须匹配 `VALID_COMMAND_NAME_REGEX`（字母数字/下划线/连字符），
 *   由 PATH 解析——这是 `node`/`python`/`bun` 等常规形态；
 * - 绝对路径：必须是真实存在的**文件**（不是目录），扩展名限 `.exe`/`.cmd`/`.bat` 或无扩展名；
 * - 两者共同：不得含 shell 元字符（`&`、`|`、`^`、`%`、引号等），相对路径一律拒绝。
 *
 * 非法输入返回 `{ ok: false, reason }`，由调用方抛出明确错误——绝不照 spawn。
 */
export function normalizeMcpCommand(command: string): { ok: true; command: string } | { ok: false; reason: string } {
  const trimmed = command.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'command is empty' }
  }
  if (SHELL_METACHARACTER_REGEX.test(trimmed)) {
    return { ok: false, reason: 'command contains shell metacharacters' }
  }
  // Windows 分隔符在 POSIX 上不算分隔符，但 `C:\evil.exe` 这类值仍必须按绝对路径处理。
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\')
  if (!hasSeparator) {
    if (!VALID_COMMAND_NAME_REGEX.test(trimmed)) {
      return {
        ok: false,
        reason: 'command must be a bare executable name (letters, digits, underscore, hyphen) or an absolute path'
      }
    }
    return { ok: true, command: trimmed }
  }

  const windowsStyleAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed)
  const resolved = isWin || windowsStyleAbsolute ? path.win32.resolve(trimmed) : resolvePath(trimmed)
  if (!(path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed))) {
    return { ok: false, reason: 'command must be an absolute path' }
  }

  const extension = path.extname(resolved).toLowerCase()
  if (extension !== '' && !WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      reason: `command path must end with ${WINDOWS_EXECUTABLE_EXTENSIONS.join('/')} or have no extension`
    }
  }
  let stats: fs.Stats
  try {
    stats = fs.statSync(resolved)
  } catch {
    return { ok: false, reason: `command path does not exist: ${resolved}` }
  }
  if (!stats.isFile()) {
    return { ok: false, reason: `command path is not a file: ${resolved}` }
  }
  return { ok: true, command: resolved }
}

/**
 * 在用户 shell 环境中查找命令的完整路径（如 'npx'、'uvx'）。
 * Windows 用 `where`，按 `.exe` → `.cmd` → `.bat` → 无扩展名绝对路径的优先级取第一条命中
 * （Node 官方安装器落的是 `npx.cmd`，只认 `.exe` 会把已装 Node 的用户误判为未安装；
 * `.cmd`/`.bat` 由 cross-spawn 转发，MCP SDK 的 StdioClientTransport 也走 cross-spawn）。
 * Unix 用 POSIX `command -v` 且只接受绝对路径。找不到返回 null（不抛错），由调用方决定兜底文案。
 */
export async function findCommandInShellEnv(command: string, env: Record<string, string>): Promise<string | null> {
  if (!VALID_COMMAND_NAME_REGEX.test(command)) {
    logger.warn(`Invalid command name '${command}' - must only contain alphanumeric characters, underscore, or hyphen`)
    return null
  }

  return new Promise((resolve) => {
    let resolved = false

    const safeResolve = (value: string | null) => {
      if (resolved) return
      resolved = true
      resolve(value)
    }

    if (isWin) {
      const child = spawn('where', [command], {
        env,
        windowsHide: true, // where.exe 是控制台子系统：不加则闪控制台窗口
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let output = ''
      const timeoutId = setTimeout(() => {
        if (resolved) return
        // 杀树而非只杀直接子进程（仓库子进程纪律：where.exe 无后代，但口径统一）。
        killProcessTree(child)
        logger.debug(`Timeout checking command '${command}' on Windows`)
        safeResolve(null)
      }, COMMAND_LOOKUP_TIMEOUT_MS)

      child.stdout?.on('data', (data) => {
        if (output.length < MAX_OUTPUT_SIZE) {
          output += data.toString()
        }
      })

      child.on('close', (code) => {
        clearTimeout(timeoutId)
        if (resolved) return

        if (code === 0 && output.trim()) {
          const paths = output.trim().split(/\r?\n/)
          // 优先级：.exe → .cmd → .bat → 无扩展名的绝对路径（后者是 POSIX 风格脚本入口）。
          const ranked = WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) =>
            paths.find((candidate) => candidate.toLowerCase().endsWith(extension))
          ).find((candidate) => candidate !== undefined)
          const extensionless = paths.find((candidate) => path.extname(candidate) === '')
          const commandPath = ranked ?? extensionless
          if (commandPath) {
            safeResolve(commandPath)
          } else {
            logger.debug(`Command '${command}' found but not in a spawnable form (${paths[0]}), treating as not found`)
            safeResolve(null)
          }
        } else {
          logger.debug(`Command '${command}' not found in shell environment`)
          safeResolve(null)
        }
      })

      child.on('error', (error) => {
        clearTimeout(timeoutId)
        if (resolved) return
        logger.warn(`Error checking command '${command}':`, { error, platform: 'windows' })
        safeResolve(null)
      })
    } else {
      // Unix/Linux/macOS：POSIX `command -v`，/bin/sh 保证可用且与用户 shell 无关
      // SECURITY: 用位置参数 $1 传命令名，防命令注入
      const child = spawn('/bin/sh', ['-c', 'command -v "$1"', '--', command], {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let output = ''
      const timeoutId = setTimeout(() => {
        if (resolved) return
        killProcessTree(child)
        logger.debug(`Timeout checking command '${command}'`)
        safeResolve(null)
      }, COMMAND_LOOKUP_TIMEOUT_MS)

      child.stdout?.on('data', (data) => {
        if (output.length < MAX_OUTPUT_SIZE) {
          output += data.toString()
        }
      })

      child.on('close', (code) => {
        clearTimeout(timeoutId)
        if (resolved) return

        if (code === 0 && output.trim()) {
          const commandPath = output.trim().split('\n')[0]

          // command -v 对 alias/builtin 可能只回显命令名，校验必须是绝对路径
          if (path.isAbsolute(commandPath)) {
            safeResolve(commandPath)
          } else {
            logger.debug(`Command '${command}' resolved to non-path '${commandPath}', treating as not found`)
            safeResolve(null)
          }
        } else {
          logger.debug(`Command '${command}' not found in shell environment`)
          safeResolve(null)
        }
      })

      child.on('error', (error) => {
        clearTimeout(timeoutId)
        if (resolved) return
        logger.warn(`Error checking command '${command}':`, { error, platform: 'unix' })
        safeResolve(null)
      })
    }
  })
}
