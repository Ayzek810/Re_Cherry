/**
 * v0.4.5-1 市场通道契约。
 *
 * 真机反馈："核心升级后插件市场不可用"——市场是 profile 里的普通依赖，核心升级它不会跟着走。
 * 但**契约不是"版本必须 ≥ 某个数"**：真机日志（本人引入的回归）显示 dsh 0.2.0-rc.2 会以
 * peer 不兼容**拒绝**被钉死的 dshmarket@1.45.1，钉死的结果是安装必失败、工具判 broken、
 * 市场永远补不上。版本权威在 dsh，故这里的契约只有两条：**装着 + 版本可读**，加上"用户删掉
 * 的市场不得复活"与"装不上不得说谎"。
 *
 * main 测试环境 mock 了 node:fs/node:path，故本件通过 MarketIo / MarketCommandRunner 端口驱动。
 */
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  ensureMarketInstalledWith,
  fetchMarketMetadata,
  type HostFacts,
  inferMarketRuntimeCompatibility,
  installMarketBundleWith,
  isMarketUsableWith,
  isUsableMarketVersion,
  type MarketCommandRunner,
  type MarketEntryKind,
  type MarketIo,
  MARKET_INSTALL_SPEC,
  MARKET_PACKAGE,
  type MarketMetadata,
  marketPaths,
  parseSemver,
  satisfiesRange,
  selectCompatibleMarketVersion
} from '../marketBaseline'

const DSH_HOME = '/mock/codemate/home/dsh'

class FakeWorkspace {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly links = new Map<string, string>()

  constructor() {
    this.dirs.add(DSH_HOME)
    this.dirs.add(path.join(DSH_HOME, 'profiles'))
    this.dirs.add(this.paths.profileDir)
    this.dirs.add(this.paths.nodeModulesDir)
  }

  readonly paths = marketPaths(DSH_HOME)

  get io(): MarketIo {
    return {
      readText: async (file) => this.files.get(file),
      writeText: async (file, contents) => {
        this.files.set(file, contents)
      },
      removeFile: async (file) => {
        this.files.delete(file)
        this.links.delete(file)
      },
      entryKind: async (target): Promise<MarketEntryKind> => {
        if (this.links.has(target)) return 'link'
        if (this.files.has(target) || this.dirs.has(target)) return 'file'
        return 'missing'
      },
      linkTarget: async (target) => this.links.get(target),
      ensureDir: async (dir) => {
        this.dirs.add(dir)
      }
    }
  }

  manifest(value: Record<string, unknown>): void {
    this.files.set(this.paths.manifestPath, `${JSON.stringify(value, undefined, 2)}\n`)
  }

  readManifest(): Record<string, unknown> {
    return JSON.parse(this.files.get(this.paths.manifestPath) ?? '{}') as Record<string, unknown>
  }

  marketPackageJson(): string {
    return path.join(this.paths.nodeModulesDir, MARKET_PACKAGE, 'package.json')
  }

  installMarket(version: string): void {
    // 真实文件系统里 package.json 落盘必然伴随目录存在——假件要把这一层也建出来，
    // 否则"目录存在性"判定（isMarketUsable）会失真。
    this.dirs.add(path.join(this.paths.nodeModulesDir, MARKET_PACKAGE))
    this.files.set(this.marketPackageJson(), JSON.stringify({ name: MARKET_PACKAGE, version }))
  }

  installedVersion(): string | undefined {
    const raw = this.files.get(this.marketPackageJson())
    return raw ? (JSON.parse(raw) as { version?: string }).version : undefined
  }
}

const declaredManifest = (spec: string): Record<string, unknown> => ({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { [MARKET_PACKAGE]: spec },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', MARKET_PACKAGE] } }
})

/** 模拟 dsh/pnpm：装到 `@latest` 对应的最新版（这里固定 1.52.0）。 */
function pnpmLikeRunner(workspace: FakeWorkspace, version = '1.52.0'): MarketCommandRunner {
  return vi.fn(async () => {
    workspace.installMarket(version)
    return ''
  }) as unknown as MarketCommandRunner
}

describe('版本判据（只判可读，不判大小）', () => {
  it('parses plain and prerelease semver', () => {
    expect(parseSemver('1.45.1')?.minor).toBe(45)
    expect(parseSemver('1.46.0-rc.2')?.prerelease).toEqual(['rc', 2])
  })

  it('accepts any readable version — dsh owns compatibility, not this module', () => {
    // 真机：dsh 0.2.0-rc.2 拒收 1.45.1，却接受它自己解析出来的版本。这里的判据不得对此表态。
    expect(isUsableMarketVersion('1.45.1')).toBe(true)
    expect(isUsableMarketVersion('1.52.0')).toBe(true)
    expect(isUsableMarketVersion('2.0.0-next.1')).toBe(true)
  })

  it('rejects missing or unreadable versions (half-installed)', () => {
    expect(isUsableMarketVersion(undefined)).toBe(false)
    expect(isUsableMarketVersion('main')).toBe(false)
  })
})

describe('ensureMarketInstalledWith', () => {
  it('does nothing when the profile has no manifest yet', async () => {
    const workspace = new FakeWorkspace()
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      installed: false
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('leaves a market the user removed alone', async () => {
    const workspace = new FakeWorkspace()
    // 依赖还在、bundle 层已被移除 = 用户禁用/卸载了市场 → 不得复活。
    workspace.manifest({ dependencies: { [MARKET_PACKAGE]: '^1.45.1' }, dsh: { profile: { bundles: [] } } })
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      installed: false
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('takes the fast path when a readable market is already installed', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.installMarket('1.45.1')
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      installed: false,
      version: '1.45.1'
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('installs the market when it is missing, and verifies what landed', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      workspace.installMarket('1.52.0')
      return ''
    }
    const outcome = await ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(outcome).toEqual({ installed: true, version: '1.52.0' })
    // 规格是 dist-tag，不是钉死的版本——钉版本会把 dsh 允许的组合判成坏（真机回归）。
    expect(calls[0]).toContain(`${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC}`)
    expect(calls[0]).toContain('--workspace-root')
    // 待修标记在成功后清掉，安装完成指纹被撤（否则后续启动会跳过安装）。
    expect(workspace.files.has(workspace.paths.pendingPath)).toBe(false)
    expect(workspace.files.has(path.join(workspace.paths.profileDir, '.install-complete'))).toBe(false)
  })

  it('reinstalls over a half-installed tree whose version is unreadable', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.dirs.add(path.join(workspace.paths.nodeModulesDir, MARKET_PACKAGE))
    workspace.files.set(workspace.marketPackageJson(), JSON.stringify({ name: MARKET_PACKAGE }))
    const outcome = await ensureMarketInstalledWith({
      dshHome: DSH_HOME,
      io: workspace.io,
      runner: pnpmLikeRunner(workspace)
    })
    expect(outcome).toEqual({ installed: true, version: '1.52.0' })
  })

  it('finishes a repair that a previous run left pending', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.installMarket('1.45.1')
    workspace.files.set(workspace.paths.pendingPath, '{"spec":"latest"}\n')
    const outcome = await ensureMarketInstalledWith({
      dshHome: DSH_HOME,
      io: workspace.io,
      runner: pnpmLikeRunner(workspace)
    })
    expect(outcome.installed).toBe(true)
    expect(workspace.files.has(workspace.paths.pendingPath)).toBe(false)
  })

  it('repairs a market left as a .generations link (community-host residue)', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const marketDir = path.join(workspace.paths.nodeModulesDir, MARKET_PACKAGE)
    workspace.links.set(marketDir, path.join(DSH_HOME, '.generations/live/dshmarket+1.45.1/node_modules/dshmarket'))
    const outcome = await ensureMarketInstalledWith({
      dshHome: DSH_HOME,
      io: workspace.io,
      runner: pnpmLikeRunner(workspace)
    })
    expect(outcome.installed).toBe(true)
    expect(workspace.installedVersion()).toBe('1.52.0')
  })

  it('rolls the manifest back and keeps the retry marker when the install fails', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.44.0'))
    const before = workspace.files.get(workspace.paths.manifestPath)
    const runner = vi.fn(async () => {
      throw new Error('dsh plugin add dshmarket@latest exited with code 1\nERR_PNPM_FETCH_404')
    }) as unknown as MarketCommandRunner

    await expect(ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /ERR_PNPM_FETCH_404/
    )
    expect(workspace.files.get(workspace.paths.manifestPath)).toBe(before)
    // 待修标记留下 → 下次启动继续补（pnpm 可能在失败前就换过包）。
    expect(workspace.files.has(workspace.paths.pendingPath)).toBe(true)
  })

  it('fails when the command reports success but nothing usable landed', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.44.0'))
    const runner = vi.fn(async () => '') as unknown as MarketCommandRunner
    await expect(ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /the active version is missing/
    )
  })
})

describe('installMarketBundleWith', () => {
  it('initializes the profile, declares the market first and verifies the install', async () => {
    const workspace = new FakeWorkspace()
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      if (args.includes('install') && !workspace.files.has(workspace.paths.manifestPath)) {
        // dsh 首次 `plugin install` 会 initProfile（模板 manifest）。
        workspace.manifest({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } })
        return ''
      }
      workspace.installMarket('1.52.0')
      return ''
    }

    const result = await installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(calls[0]).toContain('install')
    const addCall = calls.find((args) => args.includes('add'))
    expect(addCall).toBeDefined()
    expect(addCall).toContain('--workspace-root')
    expect(addCall).toContain(`${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC}`)
    expect(result.version).toBe('1.52.0')
    // 声明先落：装失败时市场至少"被声明着"，启动前的补装才知道该装它。
    expect((workspace.readManifest().dependencies as Record<string, string>)[MARKET_PACKAGE]).toBe(MARKET_INSTALL_SPEC)
  })

  it('passes each pnpm subcommand only the flags it accepts', async () => {
    // 真机事故（2026-09-29）：`--no-frozen-lockfile` 是 `pnpm install` 的开关，`pnpm add` 不认
    // ——带上它 add 直接 exit 2（unexpected argument），市场因此一直装不上。这条用例把"参数
    // 与子命令匹配"钉住：install 需要显式放行（CI 下默认冻结），add 一个 frozen 开关都不能有。
    const workspace = new FakeWorkspace()
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      if (args.includes('install')) {
        workspace.manifest({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } })
        return ''
      }
      workspace.installMarket('1.66.5')
      return ''
    }

    await installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    const installCall = calls.find((args) => args.includes('install'))
    const addCall = calls.find((args) => args.includes('add'))
    expect(installCall).toContain('--no-frozen-lockfile')
    expect(addCall).toBeDefined()
    expect(addCall).not.toContain('--no-frozen-lockfile')
    expect(addCall).not.toContain('--frozen-lockfile')
  })

  it('restores the previous manifest when the add fails', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const before = workspace.files.get(workspace.paths.manifestPath)
    const runner = vi.fn(async () => {
      throw new Error('dsh plugin add dshmarket@latest exited with code 1')
    }) as unknown as MarketCommandRunner
    await expect(installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /exited with code 1/
    )
    expect(workspace.files.get(workspace.paths.manifestPath)).toBe(before)
  })
})

describe('按 dsh 兼容性选版（真机回归的正面修复）', () => {
  // 真机事实（2026-09-29）：dsh 0.2.0-rc.2 拒收 dshmarket@1.45.1——后者只声明
  // `@deepseek-ai/dsh-settings ^0.1.*`；1.66.5 的声明里多了 `|| ^0.2.0-rc.1`，才被接受。
  // 市场还声明 `@deepseek-ai/schemastery ^3.18.1`——**另一个包、另一条版本线**，必须拿本机
  // schemastery 的已装版本去比（活探针实测：拿 dsh 版本去比会把正确的 1.66.5 误判为不兼容，
  // 从而挑出一个远古版本）。
  const INCOMPATIBLE = {
    peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2' }
  }
  const COMPATIBLE = {
    peerDependencies: {
      '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1',
      '@deepseek-ai/schemastery': '^3.18.1'
    }
  }
  /** 本机宿主事实（与真机一致：dsh 0.2.0-rc.2、dsh-settings 0.2.0-rc.2、schemastery 3.18.3）。 */
  const host = (overrides: Partial<HostFacts> = {}): HostFacts => ({
    dshVersion: '0.2.0-rc.2',
    peerVersion: async (name) =>
      name === '@deepseek-ai/schemastery' ? '3.18.3' : name === '@deepseek-ai/dsh-settings' ? '0.2.0-rc.2' : undefined,
    ...overrides
  })
  const packument = (
    versions: Record<string, { peerDependencies?: Record<string, string>; deprecated?: boolean }>,
    latest: string
  ): MarketMetadata => ({
    latest,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, manifest]) => [version, { name: MARKET_PACKAGE, version, ...manifest }])
    )
  })
  const fakeFetch = (payload: unknown): typeof fetch =>
    (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch
  /**
   * registry 的**原始 packument 形状**（`dist-tags` 那层）——走 fetch 的用例必须用它：
   * `fetchMarketMetadata` 消费的是 registry 的响应，不是本模块内的 MarketMetadata。
   */
  const registryPayload = (metadata: MarketMetadata): unknown => ({
    'dist-tags': { latest: metadata.latest },
    versions: metadata.versions
  })

  it('understands the peer ranges the registry actually publishes', () => {
    expect(satisfiesRange('0.2.0-rc.2', '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2')).toBe(false)
    expect(satisfiesRange('0.2.0-rc.2', '^0.1.0-rc.7 || ^0.2.0-rc.1')).toBe(true)
    expect(satisfiesRange('3.18.3', '^3.18.1')).toBe(true)
    expect(satisfiesRange('0.2.0', '^0.2.0-rc.1')).toBe(true)
  })

  it('judges each candidate against the installed version of THAT package', async () => {
    expect(await inferMarketRuntimeCompatibility({ version: '1.45.1', ...INCOMPATIBLE }, host())).toEqual({
      compatible: false,
      reason: expect.stringContaining('@deepseek-ai/dsh-settings')
    })
    expect((await inferMarketRuntimeCompatibility({ version: '1.66.5', ...COMPATIBLE }, host())).compatible).toBe(true)
  })

  it('ignores peers this host does not install (no evidence, not a veto)', async () => {
    const manifest = {
      version: '1.66.5',
      peerDependencies: { '@deepseek-ai/some-future-package': '^9.0.0' }
    }
    expect((await inferMarketRuntimeCompatibility(manifest, host())).compatible).toBe(true)
  })

  it('honours engines.dsh against the installed dsh version', async () => {
    expect(await inferMarketRuntimeCompatibility({ version: '1.66.5', engines: { dsh: '^0.3.0' } }, host())).toEqual({
      compatible: false,
      reason: expect.stringContaining('requires dsh')
    })
  })

  it('takes the highest compatible version, skipping incompatible and deprecated ones', async () => {
    const metadata = packument(
      {
        '1.45.1': INCOMPATIBLE,
        '1.66.5': COMPATIBLE,
        '1.67.0': { ...COMPATIBLE, deprecated: true }
      },
      '1.67.0'
    )
    expect(await selectCompatibleMarketVersion(metadata, host())).toEqual({ version: '1.66.5' })
  })

  it('returns nothing when no published version declares compatibility', async () => {
    const metadata = packument({ '1.45.1': INCOMPATIBLE }, '1.45.1')
    expect(await selectCompatibleMarketVersion(metadata, host())).toBeUndefined()
  })

  it('prefers a stable release over prereleases for a stable host', async () => {
    const metadata = packument({ '1.66.0-rc.1': COMPATIBLE, '1.65.0': COMPATIBLE }, '1.66.0-rc.1')
    expect(await selectCompatibleMarketVersion(metadata, host({ dshVersion: '0.2.0' }))).toEqual({
      version: '1.65.0'
    })
  })

  it('installs the compatible version — not the stale constant, not blindly latest', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      workspace.installMarket('1.66.5')
      return ''
    }
    const outcome = await ensureMarketInstalledWith({
      dshHome: DSH_HOME,
      io: workspace.io,
      runner,
      host: host(),
      fetchImpl: fakeFetch(registryPayload(packument({ '1.45.1': INCOMPATIBLE, '1.66.5': COMPATIBLE }, '1.66.5')))
    })
    expect(calls[0]).toContain(`${MARKET_PACKAGE}@1.66.5`)
    expect(outcome).toEqual({ installed: true, version: '1.66.5' })
  })

  it('falls back to the latest tag when no version is declared compatible', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      workspace.installMarket('1.45.1')
      return ''
    }
    await ensureMarketInstalledWith({
      dshHome: DSH_HOME,
      io: workspace.io,
      runner,
      host: host(),
      fetchImpl: fakeFetch(registryPayload(packument({ '1.45.1': INCOMPATIBLE }, '1.45.1')))
    })
    expect(calls[0]).toContain(`${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC}`)
  })

  it('falls back to the latest tag when the host is unreadable', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      workspace.installMarket('1.66.5')
      return ''
    }
    await ensureMarketInstalledWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(calls[0]).toContain(`${MARKET_PACKAGE}@${MARKET_INSTALL_SPEC}`)
  })

  it('tries the fallback registry when metadata cannot be read from the first one', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('npmmirror')) throw new Error('ECONNRESET')
      return {
        ok: true,
        status: 200,
        json: async () => registryPayload(packument({ '1.66.5': COMPATIBLE }, '1.66.5'))
      }
    }) as unknown as typeof fetch
    const metadata = await fetchMarketMetadata(fetchImpl, {
      registries: ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
    })
    expect(calls).toHaveLength(2)
    expect(metadata?.latest).toBe('1.66.5')
  })
})

describe('isMarketUsableWith', () => {
  it('rejects a missing or link-shaped market and accepts a readable one', async () => {
    const workspace = new FakeWorkspace()
    expect(await isMarketUsableWith(workspace.io, workspace.paths)).toBe(false)

    const marketDir = path.join(workspace.paths.nodeModulesDir, MARKET_PACKAGE)
    workspace.links.set(marketDir, path.join(DSH_HOME, '.generations/live/dshmarket+1.45.1/node_modules/dshmarket'))
    expect(await isMarketUsableWith(workspace.io, workspace.paths)).toBe(false)

    workspace.links.delete(marketDir)
    workspace.installMarket('1.44.0')
    // 低于某个"基线"但可读 → 启动不该因此被阻断（dsh 自己会判断兼容性）。
    expect(await isMarketUsableWith(workspace.io, workspace.paths)).toBe(true)

    workspace.files.set(workspace.marketPackageJson(), JSON.stringify({ name: MARKET_PACKAGE }))
    expect(await isMarketUsableWith(workspace.io, workspace.paths)).toBe(false)
  })
})
