import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerWarn, loggerError, toastError } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@renderer/config/constant', () => ({
  PPIO_APP_SECRET: '',
  PPIO_CLIENT_ID: 'client',
  SILICON_CLIENT_ID: 'client',
  TOKENFLUX_HOST: 'https://tokenflux.ai'
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key },
  getLanguageCode: () => 'en-US'
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ warn: loggerWarn, error: loggerError, debug: vi.fn(), info: vi.fn() })
  }
}))

import { oauthWith302AI, oauthWithAiOnly, oauthWithSiliconFlow, providerBills, providerCharge } from '../oauth'

/** 记录 add/remove 的 window 桩，供监听器注册断言。 */
class FakeWindow {
  listeners: Array<(event: MessageEvent) => void> = []
  removed: Array<(event: MessageEvent) => void> = []
  // 形参显式声明，`mock.calls[0][0]` 才可索引（否则推断成零元组）。
  open = vi.fn((_url: string, _target?: string) => ({ close: vi.fn() }) as any)
  toast = { error: toastError }
  api = { protocol: { onReceiveData: vi.fn() }, aes: { decrypt: vi.fn() } }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(handler)
  }

  removeEventListener(type: string, handler: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.removed.push(handler)
      this.listeners = this.listeners.filter((h) => h !== handler)
    }
  }

  dispatch(origin: string, data: unknown) {
    for (const listener of [...this.listeners]) {
      listener({ origin, data } as MessageEvent)
    }
  }
}

const installWindow = () => {
  const fake = new FakeWindow()
  ;(globalThis as any).window = fake
  return fake
}

/** 让监听器里的 Promise 链跑完。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('utils/oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('message listener hygiene', () => {
    it('registers exactly one listener per call and removes that same instance after handling', async () => {
      const fake = installWindow()
      const setKey = vi.fn()

      await oauthWithSiliconFlow(setKey)
      expect(fake.listeners).toHaveLength(1)
      const registered = fake.listeners[0]

      // 原实现在 addEventListener 之前对刚创建的函数 removeEventListener，
      // 永远匹配不上（removed 里不会出现已注册的那个实例）。
      expect(fake.removed).not.toContain(registered)

      fake.dispatch('https://account.siliconflow.cn', [{ secretKey: 'sk-test' }])
      await flush()

      expect(setKey).toHaveBeenCalledWith('sk-test')
      expect(fake.listeners).toHaveLength(0)
      expect(fake.removed).toContain(registered)
    })

    it('does not stack listeners on repeated clicks', async () => {
      const fake = installWindow()
      await oauthWithSiliconFlow(vi.fn())
      await oauthWithSiliconFlow(vi.fn())

      // 两次调用各注册一个（重复点击时旧监听若未注销就会叠加）
      expect(fake.listeners).toHaveLength(2)
    })

    it('ignores messages from an untrusted origin', async () => {
      const fake = installWindow()
      const setKey = vi.fn()

      await oauthWithSiliconFlow(setKey)
      fake.dispatch('https://evil.example.com', [{ secretKey: 'sk-stolen' }])
      await flush()

      expect(setKey).not.toHaveBeenCalled()
      // 未处理 → 监听器仍在（等待真正的授权页消息）
      expect(fake.listeners).toHaveLength(1)
      expect(loggerWarn).toHaveBeenCalled()
    })

    it('does not throw when event.data is undefined', async () => {
      const fake = installWindow()
      const setKey = vi.fn()

      await oauthWithSiliconFlow(setKey)
      expect(() => fake.dispatch('https://account.siliconflow.cn', undefined)).not.toThrow()
      await flush()
      expect(setKey).not.toHaveBeenCalled()
      expect(loggerWarn).not.toHaveBeenCalled()
    })

    it('handles the 302.ai payload shape', async () => {
      const fake = installWindow()
      const setKey = vi.fn()

      await oauthWith302AI(setKey)
      fake.dispatch('https://dash.302.ai', { data: { apikey: 'sk-302' } })
      await flush()

      expect(setKey).toHaveBeenCalledWith('sk-302')
      expect(fake.listeners).toHaveLength(0)
    })

    it('handles the aionly (silicon) payload shape', async () => {
      const fake = installWindow()
      const setKey = vi.fn()

      await oauthWithAiOnly(setKey)
      fake.dispatch('https://account.siliconflow.cn', [{ secretKey: 'sk-aionly' }])
      await flush()

      expect(setKey).toHaveBeenCalledWith('sk-aionly')
    })
  })

  describe('charge / bills url lookup', () => {
    it('opens the registered url for a known provider', async () => {
      const fake = installWindow()
      await providerCharge('silicon')
      expect(fake.open).toHaveBeenCalled()
      expect(fake.open.mock.calls[0][0]).toBe('https://cloud.siliconflow.cn/expensebill')
    })

    it('reports a visible error instead of throwing for an unregistered provider', async () => {
      const fake = installWindow()
      // 原实现对 chargeUrlMap[provider] 解构 undefined 抛 TypeError
      await expect(providerCharge('deepseek')).resolves.toBeUndefined()
      expect(fake.open).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalled()
      expect(loggerWarn).toHaveBeenCalled()
    })

    it('reports a visible error instead of throwing for an unregistered bills provider', async () => {
      const fake = installWindow()
      await expect(providerBills('openai')).resolves.toBeUndefined()
      expect(fake.open).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalled()
    })
  })
})
