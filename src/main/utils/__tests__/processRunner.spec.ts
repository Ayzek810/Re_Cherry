/**
 *
 * 缺陷：`executeCommand` 的超时与超量分支只 `child.kill('SIGKILL')` 杀直接子进程。同一文件的
 * `killProcessTree` 注释已写明：Windows 上 `crossPlatformSpawn` 让非 `.exe` 命令经 shell 执行，
 * 「a plain `child.kill()` only reaps the cmd.exe wrapper and leaves the real process orphaned」。
 * 受影响的是全部超时型命令（BinaryManager 的 npm/pip、readDshVersion、resolveBinary 探针）——
 * 超时后真正的 node/pip 进程树继续跑并持有 `{userData}/Data/CodeMate` 的文件句柄。
 *
 * 修法：两处改走 `killProcessTree`。
 */
import type * as NodeChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('cross-spawn', () => ({ default: spawnMock }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process')
  return { ...actual, execFile: execFileMock }
})

import { executeCommand } from '../processRunner'

/** 只实现 executeCommand + killProcessTree 消费到的子进程表面。 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  readonly kill = vi.fn(() => true)
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

const isWin = process.platform === 'win32'

describe('executeCommand process-tree termination', () => {
  let child: FakeChild

  afterEach(() => {
    vi.clearAllMocks()
  })

  function arrange(): FakeChild {
    child = new FakeChild()
    spawnMock.mockReturnValue(child)
    return child
  }

  it('kills the whole tree when the output limit is exceeded', async () => {
    const fake = arrange()
    const promise = executeCommand('npm', ['install'], { maxOutputBytes: 16, env: {} })
    // 超量触发：写入超过上限的输出。
    fake.stdout.write('x'.repeat(64))
    fake.emit('close', 0)

    await expect(promise).rejects.toThrow(/output exceeded/i)

    if (isWin) {
      // Windows：taskkill /T /F（先列后杀）——不是 child.kill()。
      expect(execFileMock).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.any(Function))
    } else {
      // POSIX：向进程组发信号（子进程是 group leader）。
      expect(fake.kill).toHaveBeenCalled()
    }
  })

  it('kills the whole tree when the command times out', async () => {
    const fake = arrange()
    const promise = executeCommand('npm', ['install'], { timeout: 20, env: {} })

    await expect(promise).rejects.toThrow(/timed out/i)

    if (isWin) {
      expect(execFileMock).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.any(Function))
    } else {
      expect(fake.kill).toHaveBeenCalled()
    }
    // 超时后 close 到达不应二次结算（promise 已 reject，这里只是确保不抛未处理异常）。
    fake.emit('close', 1)
  })

  it('does not terminate anything on a clean exit', async () => {
    const fake = arrange()
    const promise = executeCommand('node', ['--version'], { env: {} })
    fake.stdout.write('v24.0.0')
    fake.emit('close', 0)

    await expect(promise).resolves.toBe('v24.0.0')
    expect(execFileMock).not.toHaveBeenCalled()
    expect(fake.kill).not.toHaveBeenCalled()
  })
})
