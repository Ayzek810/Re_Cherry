import { beforeEach, describe, expect, it, vi } from 'vitest'

const readMock = vi.fn()
const writeWithIdMock = vi.fn()
const warnMock = vi.fn()

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: warnMock,
      info: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/utils', () => ({
  uuid: () => 'test-uuid'
}))

/**
 * r2-79 行为契约：`loadCustomMiniApp` 对读失败/坏 JSON 一律**不得写盘**。
 * 此前它把任何读失败当作"文件不存在"，向同一路径覆盖写 `'[]'`——一次瞬时读失败
 * 就永久清空用户的自定义小应用（不变式 6：不可知状态不得授权破坏性动作）。
 */
describe('config/minapps loadCustomMiniApp (r2-79)', () => {
  beforeEach(() => {
    vi.resetModules()
    readMock.mockReset()
    writeWithIdMock.mockReset()
    warnMock.mockReset()
    ;(globalThis as any).window = {
      api: {
        file: {
          read: readMock,
          writeWithId: writeWithIdMock
        }
      }
    }
  })

  it('writes nothing and returns none when the read fails (never overwrites the user file)', async () => {
    readMock.mockRejectedValueOnce(new Error('Failed to read file: custom-minapps.json.'))

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toEqual([])
    expect(writeWithIdMock).not.toHaveBeenCalled()
    expect(warnMock).toHaveBeenCalled()
  })

  it('writes nothing and returns none when the JSON is corrupt (keeps the file)', async () => {
    readMock.mockResolvedValueOnce('{ this is not json')

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toEqual([])
    expect(writeWithIdMock).not.toHaveBeenCalled()
    expect(warnMock).toHaveBeenCalled()
  })

  it('returns the custom apps when the file is valid, and still writes nothing on load', async () => {
    readMock.mockResolvedValue(JSON.stringify([{ id: 'mine', name: 'Mine', url: 'https://example.com' }]))

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toHaveLength(1)
    expect(apps[0].id).toBe('mine')
    expect(apps[0].type).toBe('Custom')
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('treats a non-array JSON payload as a failure instead of iterating it', async () => {
    readMock.mockResolvedValueOnce(JSON.stringify({ not: 'an array' }))

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toEqual([])
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })
})
