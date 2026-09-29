/**
 * v0.4.5-1 PyPI 版本源契约。
 *
 * 这一件守的是一个**真机 404**：旧实现把两源写成同一个路径模板（`${base}/<pkg>/json`），
 * 而清华镜像不实现 `/pypi/<pkg>/json`（本机实测 404）——于是"双源"里第二源恒不可用，
 * 主源不可达时"检查更新"静默无结论，渲染层把它显示成"已是最新版本"。
 *
 * 断言分两层：① 纯解析函数对四种真实响应形态（JSON API / PEP 691 / 空 versions / HTML）的行为；
 * ② 源表里每个源的端点形状必须与"该 host 实测能取到版本的那个端点"一致。
 */
import { describe, expect, it } from 'vitest'

import { PEP691_ACCEPT, PYPI_VERSION_SOURCES, readInfoVersion, readSimpleVersions } from '../pypiSources'

describe('readInfoVersion', () => {
  it('reads info.version from the JSON API payload', () => {
    expect(readInfoVersion({ info: { version: '0.19.0' } })).toBe('0.19.0')
  })

  it('returns undefined instead of guessing when the payload is not that shape', () => {
    expect(readInfoVersion({ info: {} })).toBeUndefined()
    expect(readInfoVersion({ info: { version: 19 } })).toBeUndefined()
    expect(readInfoVersion({ info: { version: '' } })).toBeUndefined()
    expect(readInfoVersion(null)).toBeUndefined()
    expect(readInfoVersion('<html>404</html>')).toBeUndefined()
  })
})

describe('readSimpleVersions', () => {
  it('takes the highest version from a PEP 700 versions array', () => {
    expect(readSimpleVersions({ versions: ['0.13.0', '0.19.0', '0.14.0'] })).toBe('0.19.0')
  })

  it('prefers a stable release over a newer prerelease', () => {
    expect(readSimpleVersions({ versions: ['0.19.0', '0.20.0-rc.1'] })).toBe('0.19.0')
  })

  it('falls back to the highest prerelease when nothing stable exists', () => {
    expect(readSimpleVersions({ versions: ['0.20.0-rc.1', '0.20.0-rc.2'] })).toBe('0.20.0-rc.2')
  })

  it('returns undefined when the mirror served HTML or an empty list', () => {
    expect(readSimpleVersions({ files: [] })).toBeUndefined()
    expect(readSimpleVersions({ versions: [] })).toBeUndefined()
    expect(readSimpleVersions({ versions: ['not-a-version', 'also-not'] })).toBeUndefined()
    expect(readSimpleVersions('<html>simple index</html>')).toBeUndefined()
  })
})

describe('PYPI_VERSION_SOURCES', () => {
  const urls = PYPI_VERSION_SOURCES.map((source) => ({ label: source.label, url: source.url('hermes-agent') }))

  it('asks the mirror first (same order as the install path) at the simple index it actually implements', () => {
    expect(urls[0]).toEqual({
      label: 'tsinghua mirror',
      url: 'https://pypi.tuna.tsinghua.edu.cn/simple/hermes-agent/'
    })
    expect(PYPI_VERSION_SOURCES[0].headers?.accept).toBe(PEP691_ACCEPT)
  })

  it('keeps the pypi.org JSON API as the fallback source', () => {
    expect(urls[1]).toEqual({ label: 'pypi.org', url: 'https://pypi.org/pypi/hermes-agent/json' })
  })

  it('never asks a non-PyPI host for the /pypi/<pkg>/json endpoint (the 404 that broke dual-source checks)', () => {
    for (const { url } of urls) {
      if (url.includes('pypi.org')) continue
      expect(url).not.toContain('/pypi/')
    }
  })

  it('has a reader that parses its own endpoint shape', () => {
    // 镜像是 PEP 691（versions[]），pypi.org 是 JSON API（info.version）——两者形状不同，
    // 所以"共用同一个 read"必然是错的：这里逐源钉住各自的读法。
    expect(PYPI_VERSION_SOURCES[0].read({ versions: ['1.2.3'] })).toBe('1.2.3')
    expect(PYPI_VERSION_SOURCES[0].read({ info: { version: '1.2.3' } })).toBeUndefined()
    expect(PYPI_VERSION_SOURCES[1].read({ info: { version: '1.2.3' } })).toBe('1.2.3')
    expect(PYPI_VERSION_SOURCES[1].read({ versions: ['1.2.3'] })).toBeUndefined()
  })
})
