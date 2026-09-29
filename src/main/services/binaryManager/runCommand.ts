// fork 缝（原创，v0.4.5-1）：受管子进程命令执行原语。
// 从 BinaryManager 的私有 runCommand 逐字抽出（两个调用方：安装器本身、市场基线通道），
// 语义不变：
// - crossPlatformSpawn（cross-spawn）负责 Windows .cmd 的 cmd.exe 转发与逐参引号；
// - stdout/stderr 各留尾部 OUTPUT_TAIL_LIMIT 字节——失败诊断要的是最后那几行（pnpm 的
//   ERR_PNPM_* 与"哪个包"总在末尾），不是开头的进度行；
// - 超时 kill 并如实上抛（kill 后 close 事件仍会到达，由 settled 守卫保证只结算一次）。

import { crossPlatformSpawn } from '@main/utils/processRunner'

/** 单条受管命令的默认超时预算（安装是分钟级；市场基线的 pnpm 安装同量级）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000

const OUTPUT_TAIL_LIMIT = 16 * 1024

export interface BoundedCommandOptions {
  env: NodeJS.ProcessEnv
  /** 命令的人类可读标识——它出现在失败消息的第一行（用户可见）。 */
  label: string
  timeoutMs?: number
  cwd?: string
}

/** 执行一条受管命令；非 0 退出/启动失败/超时一律 reject（附尾部输出）。 */
export function runBoundedCommand(executable: string, args: string[], options: BoundedCommandOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = crossPlatformSpawn(executable, args, {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {})
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      finish()
    }
    const appendTail = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-OUTPUT_TAIL_LIMIT)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk)
    })
    const timeout = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error(`${options.label} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    child.once('error', (error) => {
      settle(() => reject(new Error(`${options.label} failed to start: ${error.message}`)))
    })
    child.once('close', (code) => {
      settle(() => {
        if (code === 0) return resolve(stdout)
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(new Error(`${options.label} exited with code ${code}${output ? `\n${output}` : ''}`))
      })
    })
  })
}
