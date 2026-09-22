/**
 * v0.3.1-2：自身源导航判定测试。
 *
 * 事故：`WindowService` 的 `will-navigate` 把自身源豁免硬编码为上游 dev 端口 `localhost:517`，
 * 而本 fork 的 dev 端口是 `DSH_DEV_PORT || 5870` → dev 下对自身源的整页导航被判为外链，
 * 应用内拦下、同时 shell.openExternal 丢进系统浏览器（用户实测被拉起 `http://localhost:5870`
 * 与 `http://localhost:5870/miniWindow.html`）。
 *
 * 反证对照：同样的目标 URL，只要 currentUrl 换成别的 origin，就必须判否——
 * 证明这条豁免是"按自身源"生效，而不是"见到 http 就放行"。
 */
import { describe, expect, it } from 'vitest'

import { isSelfOriginNavigation } from '../security'

describe('isSelfOriginNavigation（自身源判定）', () => {
  it('本 fork dev 端口 5870：自身源判是（旧硬编码 517 时这里会判否＝事故）', () => {
    expect(isSelfOriginNavigation('http://localhost:5870/', 'http://localhost:5870/')).toBe(true)
    expect(
      isSelfOriginNavigation('http://localhost:5870/miniWindow.html', 'http://localhost:5870/miniWindow.html')
    ).toBe(true)
  })

  it('主窗口与 mini 窗口同源互导也判是（两者都从 dev 服务器加载）', () => {
    expect(isSelfOriginNavigation('http://localhost:5870/', 'http://localhost:5870/miniWindow.html')).toBe(true)
    expect(isSelfOriginNavigation('http://localhost:5870/miniWindow.html', 'http://localhost:5870/')).toBe(true)
  })

  it('DSH_DEV_PORT 改成任意端口都成立（与端口无关）', () => {
    expect(isSelfOriginNavigation('http://127.0.0.1:6123/', 'http://127.0.0.1:6123/index.html')).toBe(true)
  })

  it('反证：同一目标 URL，自身源换成别的 origin 必须判否（真外链仍走 openExternal）', () => {
    expect(isSelfOriginNavigation('http://localhost:5870/', 'https://github.com/')).toBe(false)
    expect(isSelfOriginNavigation('http://localhost:5870/', 'http://localhost:5173/')).toBe(false)
    expect(isSelfOriginNavigation('http://localhost:5870/', 'http://evil.example.com/')).toBe(false)
  })

  it('origin 为空/null 时一律判否（防"双方都空"被误判同源而放行任意导航）', () => {
    expect(isSelfOriginNavigation('', 'http://localhost:5870/')).toBe(false)
    expect(isSelfOriginNavigation('http://localhost:5870/', '')).toBe(false)
    expect(isSelfOriginNavigation('about:blank', 'about:blank')).toBe(false)
    expect(isSelfOriginNavigation('http://localhost:5870/', 'about:blank')).toBe(false)
  })

  it('非法 URL 不抛错，判否', () => {
    expect(isSelfOriginNavigation('not a url', 'http://localhost:5870/')).toBe(false)
    expect(isSelfOriginNavigation('http://localhost:5870/', 'not a url')).toBe(false)
  })
})
