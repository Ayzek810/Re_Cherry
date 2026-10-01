/**
 * / 行为契约：**「文件不存在」与「文件存在但读不出来」必须分开**。
 *
 * 旧实现只有一个通用错误（主进程 `readFileCore` 把任何读失败包成 `Failed to read file: …`），
 * 渲染层一律按"文件不存在"处理，于是两个相反的事实同形：
 *  ① 全新安装（还没有 `custom-minapps.json`）永远播种不了 —— 用户第一次添加自定义小应用必失败；
 *  ② 一次瞬时读失败有被当成"用户没有小应用"而覆盖写的风险。
 *
 * 观察窗 = IPC 边界：`window.api.file.readById` 的返回值就是主进程新通道的三值结果
 * （`@shared/types/fileRead` 的 `FileReadByIdResult`）。本文件替身这一层，逐条钉住语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readByIdMock, writeWithIdMock, toastMocks, loggerMocks } = vi.hoisted(() => ({
  readByIdMock: vi.fn(),
  writeWithIdMock: vi.fn(),
  toastMocks: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
  loggerMocks: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), silly: vi.fn() }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerMocks
  }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

describe('config/minapps 读自定义小应用', () => {
  beforeEach(() => {
    vi.resetModules()
    readByIdMock.mockReset()
    writeWithIdMock.mockReset()
    toastMocks.error.mockReset()
    loggerMocks.error.mockReset()
    ;(globalThis as any).window = {
      api: {
        file: {
          readById: readByIdMock,
          writeWithId: writeWithIdMock
        }
      },
      toast: toastMocks
    }
  })

  it('missing（确定不存在）→ 空列表，是合法缺省而不是失败；不写盘、不报错', async () => {
    readByIdMock.mockResolvedValue({ status: 'missing' })

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toEqual([])
    expect(writeWithIdMock).not.toHaveBeenCalled()
    expect(toastMocks.error).not.toHaveBeenCalled()
    expect(loggerMocks.error).not.toHaveBeenCalled()
  })

  it('error（存在但读不出来）→ **必须抛出**，绝不静默返回空列表，也绝不写盘', async () => {
    readByIdMock.mockResolvedValue({ status: 'error', message: 'EBUSY: resource busy or locked' })

    const { loadCustomMiniApp } = await import('../minapps')

    // 旧实现这里 resolve 成 []（"失败长得像空结果"），本条即反证。
    await expect(loadCustomMiniApp()).rejects.toThrow('EBUSY')
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('error 与 missing 在判别式上可区分（三值契约）', async () => {
    readByIdMock.mockResolvedValue({ status: 'missing' })
    const { readCustomMiniApps } = await import('../minapps')
    const missing = await readCustomMiniApps()

    readByIdMock.mockResolvedValue({ status: 'error', message: 'EACCES' })
    const failed = await readCustomMiniApps()

    expect(missing.status).toBe('missing')
    expect(failed.status).toBe('error')
    expect(failed).not.toEqual(missing)
  })

  it('IPC 调用本身被拒（旧 preload / invoke 拒绝）→ 也是 error，不当成 missing', async () => {
    readByIdMock.mockRejectedValue(new Error('preload: channel "file:readById" is not exposed'))

    const { readCustomMiniApps } = await import('../minapps')
    const result = await readCustomMiniApps()

    expect(result.status).toBe('error')
  })

  it('ok + 合法 JSON → 返回自定义应用，且读路径不写盘', async () => {
    readByIdMock.mockResolvedValue({
      status: 'ok',
      content: JSON.stringify([{ id: 'mine', name: 'Mine', url: 'https://example.com' }])
    })

    const { loadCustomMiniApp } = await import('../minapps')
    const apps = await loadCustomMiniApp()

    expect(apps).toHaveLength(1)
    expect(apps[0].id).toBe('mine')
    expect(apps[0].type).toBe('Custom')
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('ok + 坏 JSON → error（不降级为空列表），不写盘', async () => {
    readByIdMock.mockResolvedValue({ status: 'ok', content: '{ this is not json' })

    const { loadCustomMiniApp } = await import('../minapps')

    await expect(loadCustomMiniApp()).rejects.toThrow()
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('ok + 非数组载荷 → error（不迭代它），不写盘', async () => {
    readByIdMock.mockResolvedValue({ status: 'ok', content: JSON.stringify({ not: 'an array' }) })

    const { loadCustomMiniApp } = await import('../minapps')

    await expect(loadCustomMiniApp()).rejects.toThrow('does not contain an array')
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('updateCustomMiniApps：missing → 从空列表开始**首次创建**该文件（全新安装的添加路径）', async () => {
    readByIdMock.mockResolvedValue({ status: 'missing' })
    writeWithIdMock.mockResolvedValue(undefined)

    const { updateCustomMiniApps } = await import('../minapps')
    const next = await updateCustomMiniApps((apps) => [
      ...apps,
      { id: 'first', name: 'First', url: 'https://example.com', type: 'Custom' } as any
    ])

    expect(next).toHaveLength(1)
    expect(writeWithIdMock).toHaveBeenCalledTimes(1)
    const [fileId, payload] = writeWithIdMock.mock.calls[0]
    expect(fileId).toBe('custom-minapps.json')
    expect(JSON.parse(payload).map((a: { id: string }) => a.id)).toEqual(['first'])
  })

  it('updateCustomMiniApps：error → **抛出且零写入**（绝不覆盖读不出来的用户文件）', async () => {
    readByIdMock.mockResolvedValue({ status: 'error', message: 'EBUSY' })

    const { updateCustomMiniApps } = await import('../minapps')

    await expect(updateCustomMiniApps((apps) => [...apps])).rejects.toThrow('EBUSY')
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('updateCustomMiniApps：ok → 在**磁盘上的现值**上变更（不是启动快照）', async () => {
    readByIdMock.mockResolvedValue({
      status: 'ok',
      content: JSON.stringify([
        { id: 'a', name: 'A', url: 'https://a.example.com' },
        { id: 'b', name: 'B', url: 'https://b.example.com' }
      ])
    })
    writeWithIdMock.mockResolvedValue(undefined)

    const { updateCustomMiniApps } = await import('../minapps')
    const next = await updateCustomMiniApps((apps) => apps.filter((app) => app.id !== 'a'))

    expect(next.map((app) => app.id)).toEqual(['b'])
    expect(JSON.parse(writeWithIdMock.mock.calls[0][1])).toHaveLength(1)
  })

  it('启动播种：读不出来时只内置应用 + 记 error + 待展示提示 + 不写盘（失败不静默）', async () => {
    readByIdMock.mockResolvedValue({ status: 'error', message: 'EBUSY' })

    const { allMinApps, ORIGIN_DEFAULT_MIN_APPS, takeCustomMiniAppsLoadError } = await import('../minapps')

    expect(allMinApps).toHaveLength(ORIGIN_DEFAULT_MIN_APPS.length)
    // 启动期 `window.toast` 尚未赋值（TopView 在挂载 effect 里才设置），所以这里不作场弹 toast，
    // 而是记下待展示的文案；否则那次 toast 会静默 no-op，失败只剩日志。
    expect(takeCustomMiniAppsLoadError()).toBe('settings.miniapps.custom.load_error')
    // 一次性：取过一次之后不再重复打扰。
    expect(takeCustomMiniAppsLoadError()).toBeNull()
    expect(loggerMocks.error).toHaveBeenCalled()
    expect(writeWithIdMock).not.toHaveBeenCalled()
  })

  it('启动播种：missing 时也是内置应用，但**不**留下任何提示（合法缺省）', async () => {
    readByIdMock.mockResolvedValue({ status: 'missing' })

    const { allMinApps, ORIGIN_DEFAULT_MIN_APPS, takeCustomMiniAppsLoadError } = await import('../minapps')

    expect(allMinApps).toHaveLength(ORIGIN_DEFAULT_MIN_APPS.length)
    expect(takeCustomMiniAppsLoadError()).toBeNull()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})
