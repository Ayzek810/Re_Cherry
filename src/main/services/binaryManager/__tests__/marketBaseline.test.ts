/**
 * v0.4.5-1 市场通道契约（社区版 dsh-desktop market-baseline 机制的 fork 对位）。
 *
 * 为什么这些断言值得存在：真机反馈"核心升级后插件市场不可用"的根因是市场版本从不被核验
 * 也不被修复。这里的每一条都对应一种真机上出现过的形态——旧版市场、半途完成的安装、
 * 装完但实际版本没动（pnpm 退出 0 的空转）、以及"用户删掉的市场不得复活"。
 * main 测试环境 mock 了 node:fs/node:path，故本件通过 MarketIo / MarketCommandRunner 端口
 * 驱动（真实实现的默认绑定在 marketBaseline.ts 底部，见 nodeMarketIo / managedMarketRunner）。
 */
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  cleanVersionSpec,
  compareSemver,
  ensureMarketBaselineWith,
  installMarketBundleWith,
  type MarketCommandRunner,
  type MarketEntryKind,
  type MarketIo,
  MARKET_PACKAGE,
  marketPaths,
  marketUsableWithoutBaselineWith,
  meetsMarketBaseline,
  RECOMMENDED_MARKET_VERSION,
  selectMarketTargetVersion,
  VERIFIED_MARKET_BASELINE
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
    // 否则"目录存在性"判定（marketUsableWithoutBaseline）会失真。
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

/** 模拟 pnpm：按 manifest 里钉定的版本落一个真实安装（成功路径）。 */
function pnpmLikeRunner(workspace: FakeWorkspace): MarketCommandRunner {
  return vi.fn(async () => {
    const spec = (workspace.readManifest().dependencies as Record<string, string>)[MARKET_PACKAGE]
    workspace.installMarket(cleanVersionSpec(spec))
    return ''
  }) as unknown as MarketCommandRunner
}

describe('semver 原语（社区版移植）', () => {
  it('orders releases and prereleases', () => {
    expect(compareSemver('1.45.1', '1.44.9')).toBe(1)
    expect(compareSemver('1.45.1', '1.45.1')).toBe(0)
    expect(compareSemver('1.45.1-rc.1', '1.45.1')).toBe(-1)
    expect(compareSemver('1.45.2', '1.45.1')).toBe(1)
  })

  it('treats an unparseable version as lower than any release', () => {
    expect(compareSemver('not-a-version', '1.0.0')).toBe(-1)
  })

  it('strips a range prefix when reading the declared version', () => {
    expect(cleanVersionSpec('^1.45.1')).toBe('1.45.1')
    expect(cleanVersionSpec('>=1.45.1')).toBe('1.45.1')
  })
})

describe('meetsMarketBaseline', () => {
  it('accepts the baseline and anything newer', () => {
    expect(meetsMarketBaseline(VERIFIED_MARKET_BASELINE)).toBe(true)
    expect(meetsMarketBaseline('1.52.0')).toBe(true)
  })

  it('rejects older, missing and unreadable versions', () => {
    expect(meetsMarketBaseline('1.44.0')).toBe(false)
    expect(meetsMarketBaseline(undefined)).toBe(false)
    expect(meetsMarketBaseline('main')).toBe(false)
  })
})

describe('selectMarketTargetVersion', () => {
  it('falls back to the baseline when nothing else is known', () => {
    expect(selectMarketTargetVersion({})).toBe(VERIFIED_MARKET_BASELINE)
  })

  it('never downgrades an installed version', () => {
    expect(selectMarketTargetVersion({ declared: '^1.45.1', installed: '1.52.0' })).toBe('1.52.0')
  })

  it('uses the declared version when it is the highest (a half-finished install)', () => {
    expect(selectMarketTargetVersion({ declared: '1.46.0', installed: '1.45.1' })).toBe('1.46.0')
  })
})

describe('ensureMarketBaselineWith', () => {
  it('does nothing when the profile has no manifest yet', async () => {
    const workspace = new FakeWorkspace()
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      repaired: false
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('leaves a market the user removed alone', async () => {
    const workspace = new FakeWorkspace()
    // 依赖还在、bundle 层已被移除 = 用户禁用/卸载了市场 → 不得复活。
    workspace.manifest({ dependencies: { [MARKET_PACKAGE]: '^1.45.1' }, dsh: { profile: { bundles: [] } } })
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      repaired: false
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('takes the fast path when the installed version already meets the baseline', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.installMarket('1.45.1')
    const runner = vi.fn() as unknown as MarketCommandRunner
    await expect(ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })).resolves.toEqual({
      repaired: false,
      version: '1.45.1'
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('repairs an install left below the baseline and verifies the active version', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.44.0'))
    workspace.installMarket('1.44.0')
    const runner = pnpmLikeRunner(workspace)
    const outcome = await ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(outcome).toEqual({ repaired: true, version: VERIFIED_MARKET_BASELINE })
    expect(workspace.installedVersion()).toBe(VERIFIED_MARKET_BASELINE)
    // 修复把 manifest 钉到精确目标（社区版 upgradeMarketInSharedTree 同款），并撤掉安装完成标记。
    expect((workspace.readManifest().dependencies as Record<string, string>)[MARKET_PACKAGE]).toBe(
      VERIFIED_MARKET_BASELINE
    )
    expect(workspace.files.has(path.join(workspace.paths.profileDir, '.install-complete'))).toBe(false)
    expect(workspace.files.has(workspace.paths.pendingPath)).toBe(false)
  })

  it('finishes a half-installed newer version instead of downgrading it', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.installMarket('1.46.0')
    // 上一次修复没跑完留下的标记：即使版本已达标也要再修一遍。
    workspace.files.set(workspace.paths.pendingPath, '{"targetVersion":"1.46.0"}\n')
    const runner = pnpmLikeRunner(workspace)
    const outcome = await ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(outcome).toEqual({ repaired: true, version: '1.46.0' })
  })

  it('rolls the manifest back and keeps the retry marker when the install fails', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.44.0'))
    workspace.installMarket('1.44.0')
    const before = workspace.files.get(workspace.paths.manifestPath)
    const runner = vi.fn(async () => {
      throw new Error('pnpm install exited with code 1\nERR_PNPM_FETCH_404')
    }) as unknown as MarketCommandRunner

    await expect(ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /ERR_PNPM_FETCH_404/
    )
    expect(workspace.files.get(workspace.paths.manifestPath)).toBe(before)
    // 待修标记留下 → 下次启动继续修（社区版同款：pnpm 可能在失败前就换过包）。
    expect(workspace.files.has(workspace.paths.pendingPath)).toBe(true)
  })

  it('fails when pnpm reports success but the active version did not move', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.44.0'))
    workspace.installMarket('1.44.0')
    const runner = vi.fn(async () => '') as unknown as MarketCommandRunner
    await expect(ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /the active version is 1\.44\.0/
    )
  })

  it('repairs a market left as a .generations link (community-host residue)', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    const marketDir = path.join(workspace.paths.nodeModulesDir, MARKET_PACKAGE)
    workspace.links.set(marketDir, path.join(DSH_HOME, '.generations/live/dshmarket+1.45.1/node_modules/dshmarket'))
    const runner = pnpmLikeRunner(workspace)
    const outcome = await ensureMarketBaselineWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(outcome.repaired).toBe(true)
    expect(workspace.installedVersion()).toBe(VERIFIED_MARKET_BASELINE)
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
      const spec = (args.find((arg) => arg.startsWith(`${MARKET_PACKAGE}@`)) ?? '').split('@')[1] ?? ''
      workspace.installMarket(cleanVersionSpec(spec))
      return ''
    }

    const result = await installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(calls[0]).toContain('install')
    const addCall = calls.find((args) => args.includes('add'))
    expect(addCall).toBeDefined()
    // 社区版形状：显式规格 + --workspace-root（缺了它 pnpm 会把依赖写进错误的 manifest）。
    expect(addCall).toContain('--workspace-root')
    expect(addCall).toContain(`${MARKET_PACKAGE}@${RECOMMENDED_MARKET_VERSION}`)
    expect(result.version).toBe(VERIFIED_MARKET_BASELINE)
  })

  it('fails when the add reports success without a usable market', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } })
    const runner = vi.fn(async () => '') as unknown as MarketCommandRunner
    await expect(installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })).rejects.toThrow(
      /requires >=1\.45\.1/
    )
  })

  it('reinstalls at the installed version instead of downgrading it to the recommended range', async () => {
    const workspace = new FakeWorkspace()
    workspace.manifest(declaredManifest('^1.45.1'))
    workspace.installMarket('1.52.0')
    const calls: string[][] = []
    const runner: MarketCommandRunner = async (args) => {
      calls.push([...args])
      const spec = (args.find((arg) => arg.startsWith(`${MARKET_PACKAGE}@`)) ?? '').split('@')[1] ?? ''
      workspace.installMarket(cleanVersionSpec(spec))
      return ''
    }
    const result = await installMarketBundleWith({ dshHome: DSH_HOME, io: workspace.io, runner })
    expect(calls[0]).toContain(`${MARKET_PACKAGE}@1.52.0`)
    expect(result.version).toBe('1.52.0')
  })
})

describe('marketUsableWithoutBaselineWith', () => {
  it('rejects a missing or link-shaped market and accepts a readable one', async () => {
    const workspace = new FakeWorkspace()
    expect(await marketUsableWithoutBaselineWith(workspace.io, workspace.paths)).toBe(false)

    const marketDir = path.join(workspace.paths.nodeModulesDir, MARKET_PACKAGE)
    workspace.links.set(marketDir, path.join(DSH_HOME, '.generations/live/dshmarket+1.45.1/node_modules/dshmarket'))
    expect(await marketUsableWithoutBaselineWith(workspace.io, workspace.paths)).toBe(false)

    workspace.links.delete(marketDir)
    workspace.installMarket('1.44.0')
    // 低于基线但可读 → 启动不该被阻断（受限网络下修不动是常态）。
    expect(await marketUsableWithoutBaselineWith(workspace.io, workspace.paths)).toBe(true)

    workspace.files.set(workspace.marketPackageJson(), JSON.stringify({ name: MARKET_PACKAGE }))
    expect(await marketUsableWithoutBaselineWith(workspace.io, workspace.paths)).toBe(false)
  })
})
