import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.5.3',
    getPath: (name: string) => `/tmp/re-cherry-update-test/${name}`,
    isPackaged: false,
    quit: vi.fn()
  },
  net: { request: vi.fn() }
}))

vi.mock('../WindowService', () => ({ windowService: { getMainWindow: () => null } }))

const {
  buildReleaseEndpoint,
  compareVersions,
  DEFAULT_UPDATE_SOURCE,
  isPortableRuntime,
  normalizeTagVersion,
  parsePrefsPatch,
  parseSha256Digest,
  pickInstallerAsset,
  resolveSourceUrl
} = await import('../AppUpdateService')

const asset = (name: string, size = 1024) => ({ name, size, browser_download_url: `https://example.test/${name}` })

describe('normalizeTagVersion', () => {
  it('去掉 v 前缀', () => {
    expect(normalizeTagVersion('v1.0.0')).toBe('1.0.0')
    expect(normalizeTagVersion('V0.5.3')).toBe('0.5.3')
    expect(normalizeTagVersion(' 1.0.0 ')).toBe('1.0.0')
  })
})

describe('compareVersions', () => {
  it('按数字段比较', () => {
    expect(compareVersions('1.0.0', '0.5.3')).toBe(1)
    expect(compareVersions('0.5.3', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
  })

  it('缺段按 0 处理', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0')).toBe(1)
  })

  it('`-修订号` 是基准版本之后的修订，不是预发布', () => {
    expect(compareVersions('0.4.6-1', '0.4.6')).toBe(1)
    expect(compareVersions('0.4.7', '0.4.6-1')).toBe(1)
    expect(compareVersions('0.5.3', '0.5.2-3')).toBe(1)
  })

  it('多位数字按数值而非字典序比较', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0-1', '1.0.0')).toBe(1)
    // `-0` 与基准版本同段：本仓方案里没有预发布语义，故视为相等。
    expect(compareVersions('1.0.0-0', '1.0.0')).toBe(0)
  })
})

describe('pickInstallerAsset', () => {
  it('优先选带架构的 setup，而不是便携版', () => {
    const picked = pickInstallerAsset(
      [asset('Re_Cherry-1.0.0-x64-portable.exe'), asset('Re_Cherry-1.0.0-x64-setup.exe', 2048)],
      'x64'
    )
    expect(picked?.name).toBe('Re_Cherry-1.0.0-x64-setup.exe')
    expect(picked?.size).toBe(2048)
  })

  it('按架构挑，arm64 不会拿到 x64', () => {
    const picked = pickInstallerAsset(
      [asset('Re_Cherry-1.0.0-x64-setup.exe'), asset('Re_Cherry-1.0.0-arm64-setup.exe')],
      'arm64'
    )
    expect(picked?.name).toBe('Re_Cherry-1.0.0-arm64-setup.exe')
  })

  it('没有匹配架构时退到任意 setup', () => {
    const picked = pickInstallerAsset([asset('Re_Cherry-1.0.0-ia32-setup.exe')], 'x64')
    expect(picked?.name).toBe('Re_Cherry-1.0.0-ia32-setup.exe')
  })

  it('忽略 blockmap；一个都没有时返回 null', () => {
    expect(pickInstallerAsset([asset('Re_Cherry-1.0.0-x64-setup.exe.blockmap')], 'x64')).toBeNull()
    expect(pickInstallerAsset([], 'x64')).toBeNull()
    expect(pickInstallerAsset(undefined, 'x64')).toBeNull()
  })
})

describe('parseSha256Digest', () => {
  const digest = 'a'.repeat(64)

  it('接受 sha256:<64 hex>，大小写都行', () => {
    expect(parseSha256Digest(`sha256:${digest}`)).toBe(digest)
    expect(parseSha256Digest(`SHA256:${digest.toUpperCase()}`)).toBe(digest)
  })

  it('其它算法、长度不对、空值都返回 null', () => {
    expect(parseSha256Digest(`sha512:${digest}`)).toBeNull()
    expect(parseSha256Digest('sha256:abc')).toBeNull()
    expect(parseSha256Digest(null)).toBeNull()
    expect(parseSha256Digest(undefined)).toBeNull()
    expect(parseSha256Digest('')).toBeNull()
  })
})

describe('resolveSourceUrl / buildReleaseEndpoint', () => {
  it('空串与非 http(s) 用默认源', () => {
    expect(resolveSourceUrl('')).toBe(DEFAULT_UPDATE_SOURCE)
    expect(resolveSourceUrl('   ')).toBe(DEFAULT_UPDATE_SOURCE)
    expect(resolveSourceUrl('ftp://mirror.test')).toBe(DEFAULT_UPDATE_SOURCE)
    expect(resolveSourceUrl(null)).toBe(DEFAULT_UPDATE_SOURCE)
  })

  it('去掉末尾斜杠，保留自建镜像地址', () => {
    expect(resolveSourceUrl('https://mirror.test/updates/')).toBe('https://mirror.test/updates')
  })

  it('端点拼接覆盖三种写法', () => {
    expect(buildReleaseEndpoint('')).toBe(`${DEFAULT_UPDATE_SOURCE}/releases/latest`)
    expect(buildReleaseEndpoint('https://api.github.com/repos/o/r')).toBe(
      'https://api.github.com/repos/o/r/releases/latest'
    )
    expect(buildReleaseEndpoint('https://api.github.com/repos/o/r/releases')).toBe(
      'https://api.github.com/repos/o/r/releases/latest'
    )
    expect(buildReleaseEndpoint('https://api.github.com/repos/o/r/releases/latest')).toBe(
      'https://api.github.com/repos/o/r/releases/latest'
    )
    expect(buildReleaseEndpoint('https://mirror.test/updates')).toBe('https://mirror.test/updates/releases/latest')
  })
})

describe('parsePrefsPatch', () => {
  it('只接受认识的键与正确的类型', () => {
    expect(parsePrefsPatch({ sourceUrl: 'https://a.test', autoDownload: true, ignoredVersion: '1.0.0' })).toEqual({
      sourceUrl: 'https://a.test',
      autoDownload: true,
      ignoredVersion: '1.0.0'
    })
    expect(parsePrefsPatch({ autoDownload: 'yes', sourceUrl: 42, nope: 1 })).toEqual({})
    expect(parsePrefsPatch({ ignoredVersion: null })).toEqual({ ignoredVersion: null })
  })

  it('非对象一律当空补丁', () => {
    expect(parsePrefsPatch(null)).toEqual({})
    expect(parsePrefsPatch('x')).toEqual({})
    expect(parsePrefsPatch(undefined)).toEqual({})
  })
})

describe('isPortableRuntime', () => {
  it('由 NSIS 便携目标注入的环境变量判定', () => {
    const original = process.env.PORTABLE_EXECUTABLE_DIR
    delete process.env.PORTABLE_EXECUTABLE_DIR
    expect(isPortableRuntime()).toBe(false)
    process.env.PORTABLE_EXECUTABLE_DIR = 'D:/apps'
    expect(isPortableRuntime()).toBe(true)
    if (original === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR
    else process.env.PORTABLE_EXECUTABLE_DIR = original
  })
})
