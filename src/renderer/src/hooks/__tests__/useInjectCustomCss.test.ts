/**
 * `customCss` 注入只保留**一个实现**（`useInjectCustomCss`），主窗口与 mini 窗口共用。
 * 这里钉住原实现的注入形态：元素 id 固定、同值重渲染不叠加、空值移除旧元素。
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useInjectCustomCss } from '../useInjectCustomCss'

const elementId = 'user-defined-custom-css'

describe('useInjectCustomCss', () => {
  it('注入 <style id="user-defined-custom-css">，变更时替换而非叠加', () => {
    document.head.innerHTML = ''
    const { rerender, unmount } = renderHook(({ css }: { css: string }) => useInjectCustomCss(css), {
      initialProps: { css: 'body { color: red; }' }
    })
    expect(document.querySelectorAll(`#${elementId}`)).toHaveLength(1)
    expect(document.getElementById(elementId)?.textContent).toBe('body { color: red; }')

    rerender({ css: 'body { color: blue; }' })
    expect(document.querySelectorAll(`#${elementId}`)).toHaveLength(1)
    expect(document.getElementById(elementId)?.textContent).toBe('body { color: blue; }')
    unmount()
  })

  it('空值移除旧元素（不注入空 style）', () => {
    document.head.innerHTML = ''
    const { rerender } = renderHook(({ css }: { css: string | undefined }) => useInjectCustomCss(css), {
      initialProps: { css: 'body { color: red; }' as string | undefined }
    })
    expect(document.getElementById(elementId)).not.toBeNull()

    rerender({ css: undefined })
    expect(document.getElementById(elementId)).toBeNull()
  })

  it('同值重渲染不重复注入（依赖就是 customCss）', () => {
    document.head.innerHTML = ''
    const { rerender } = renderHook(({ css }: { css: string }) => useInjectCustomCss(css), {
      initialProps: { css: 'body { color: red; }' }
    })
    const first = document.getElementById(elementId)
    rerender({ css: 'body { color: red; }' })
    expect(document.querySelectorAll(`#${elementId}`)).toHaveLength(1)
    expect(document.getElementById(elementId)).toBe(first)
  })
})
