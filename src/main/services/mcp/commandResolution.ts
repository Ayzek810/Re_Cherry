/**
 * v0.3.2 批次3 自 CS_V1 移植 + 裁剪清单。
 *
 * 自 CS_V1 src/main/utils/process.ts 的 findCommandInShellEnv 移植（fork 主进程 utils
 * 无该工具，按批次3 范围收纳于 services/mcp/ 下）。
 *
 * 适配：CS_V1 传入登录 shell 环境（getLoginShellEnvironment，macOS/Linux GUI 应用
 * 不继承 shell PATH 才需要）；fork MVP 直接快照 process.env 作为查找与子进程环境。
 *
 * 裁剪：bundled binary 兜底（isBinaryExists/getBinaryPath）不在本文件——双缺时由
 * MCPService 抛出引导安装 Node.js/uv 的错误文案；findExecutable/findViaMise 等其余
 * process.ts 工具未移植。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('MCPService:commandResolution')

const isWin = process.platform === 'win32'

// 命令查找超时（毫秒）
const COMMAND_LOOKUP_TIMEOUT_MS = 5000

// 命令名校验：仅字母数字/下划线/连字符，防命令注入
const VALID_COMMAND_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/

// 输出上限，防缓冲区溢出（10KB）
const MAX_OUTPUT_SIZE = 10240

/**
 * 快照 process.env 为 Record<string, string>（过滤 undefined），可再叠加服务器私有 env。
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
 * 在用户 shell 环境中查找命令的完整路径（如 'npx'、'uvx'）。
 * Windows 用 `where` 且只接受 .exe（.cmd/.bat 无法被 SDK StdioClientTransport 的
 * spawn({shell:false}) 执行）；Unix 用 POSIX `command -v` 且只接受绝对路径。
 * 找不到返回 null（不抛错），由调用方决定兜底文案。
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
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let output = ''
      const timeoutId = setTimeout(() => {
        if (resolved) return
        child.kill('SIGKILL')
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
          // Windows 上只接受 .exe——.cmd/.bat 无法用 spawn({shell:false}) 执行（SDK 行为）
          const exePath = paths.find((p) => p.toLowerCase().endsWith('.exe'))
          if (exePath) {
            safeResolve(exePath)
          } else {
            logger.debug(`Command '${command}' found but not as .exe (${paths[0]}), treating as not found`)
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
        child.kill('SIGKILL')
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
