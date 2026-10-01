import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger, powerMonitorHandlers, mockSend } = vi.hoisted(() => {
  // 事件名 → handler 的登记表：模拟 electron powerMonitor，测试里手动 emit
  const powerMonitorHandlers = new Map<string, () => void>()
  return {
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    powerMonitorHandlers,
    mockSend: vi.fn()
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mockLogger
  }
}))

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn((event: string, handler: () => void) => {
      powerMonitorHandlers.set(event, handler)
    })
  }
}))

vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { send: mockSend }
    }))
  }
}))

describe('PowerMonitorService', () => {
  beforeEach(() => {
    powerMonitorHandlers.clear()
    vi.clearAllMocks()
    // 单例状态隔离：每个用例重新加载模块，init 的 initialized 标记互不串扰
    vi.resetModules()
  })

  it('registers suspend/resume/shutdown listeners exactly once on init', async () => {
    const { powerMonitorService } = await import('../PowerMonitorService')
    const { powerMonitor } = (await import('electron')) as unknown as {
      powerMonitor: { on: ReturnType<typeof vi.fn> }
    }

    powerMonitorService.init()
    powerMonitorService.init()

    expect(powerMonitor.on).toHaveBeenCalledTimes(3)
    expect([...powerMonitorHandlers.keys()].sort()).toEqual(['resume', 'shutdown', 'suspend'])
    // 重复 init 幂等：不再追加监听，仅告警
    expect(mockLogger.warn).toHaveBeenCalledWith('PowerMonitorService already initialized')
  })

  it('requests a lightweight save on suspend', async () => {
    const { powerMonitorService } = await import('../PowerMonitorService')
    powerMonitorService.init()

    powerMonitorHandlers.get('suspend')?.()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(IpcChannel.App_SaveData)
  })

  it('requests a lightweight save on shutdown', async () => {
    const { powerMonitorService } = await import('../PowerMonitorService')
    powerMonitorService.init()

    powerMonitorHandlers.get('shutdown')?.()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(IpcChannel.App_SaveData)
  })

  it('only logs on resume (no save request)', async () => {
    const { powerMonitorService } = await import('../PowerMonitorService')
    powerMonitorService.init()

    powerMonitorHandlers.get('resume')?.()

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledWith('System resume detected', { platform: process.platform })
  })

  it('skips the save request without a usable main window (no throw)', async () => {
    const { windowService } = await import('../WindowService')
    // Once 变体：只影响本次调用，不泄漏到后续用例
    ;(windowService.getMainWindow as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
    const { powerMonitorService } = await import('../PowerMonitorService')
    powerMonitorService.init()

    expect(() => powerMonitorHandlers.get('suspend')?.()).not.toThrow()
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith('Main window unavailable, skip lightweight save on suspend')
  })

  it('swallows window send failures (log only, no throw)', async () => {
    mockSend.mockImplementation(() => {
      throw new Error('webContents gone')
    })
    const { powerMonitorService } = await import('../PowerMonitorService')
    powerMonitorService.init()

    expect(() => powerMonitorHandlers.get('shutdown')?.()).not.toThrow()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Lightweight save on shutdown failed',
      expect.objectContaining({ message: 'webContents gone' })
    )
  })
})
