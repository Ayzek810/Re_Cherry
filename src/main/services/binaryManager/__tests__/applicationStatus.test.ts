/**
 * （）受管安装"完好/损坏"判定契约。
 *
 * 真机形态：dsh 核心换成新版、市场/PPT 装配那一步失败 → 可执行物在、`--version` 也跑得起来，
 * 于是被判 applied、版本卡还显示"最新版本"，而用户看到的是"升级成功了，但插件市场不可用"，
 * 且没有重试入口。关键判据是**版本标记**——安装器把它写在最后一步。
 */
import { describe, expect, it } from 'vitest'

import { judgeManagedApplication } from '../applicationStatus'

describe('judgeManagedApplication', () => {
  it('treats a missing version marker as broken (the install never finished)', () => {
    // dsh 的情形：shim 在、--version 通过，但 bundle 装配失败 → 没有标记。
    expect(judgeManagedApplication({ kind: 'npm', hasVersionMarker: false, probeRunnable: true })).toBe('broken')
  })

  it('is applied when every fact holds', () => {
    expect(
      judgeManagedApplication({
        kind: 'npm',
        hasVersionMarker: true,
        probeRunnable: true,
        requiredPeerSatisfied: true
      })
    ).toBe('applied')
  })

  it('treats a missing required peer as broken', () => {
    expect(
      judgeManagedApplication({
        kind: 'npm',
        hasVersionMarker: true,
        probeRunnable: true,
        requiredPeerSatisfied: false
      })
    ).toBe('broken')
  })

  it('requires the deployed front end for a source tool', () => {
    const base = { kind: 'source', hasVersionMarker: true, probeRunnable: true } as const
    expect(judgeManagedApplication({ ...base, frontDeployed: false })).toBe('broken')
    expect(judgeManagedApplication({ ...base, frontDeployed: true })).toBe('applied')
  })

  it('treats a failing --version probe as broken', () => {
    expect(
      judgeManagedApplication({
        kind: 'venv',
        hasVersionMarker: true,
        probeRunnable: false
      })
    ).toBe('broken')
  })

  it('ignores the front-end fact for non-source tools', () => {
    expect(
      judgeManagedApplication({
        kind: 'venv',
        hasVersionMarker: true,
        probeRunnable: true,
        frontDeployed: false
      })
    ).toBe('applied')
  })
})
