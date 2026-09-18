/**
 * 图片句柄短锚（v0.3.1 上下文净化 A'）单测：
 * - 格式 = `图片N (宽x高px)`，编号进程内首见序、同 id 稳定；
 * - 形状不认识 / 异常 → undefined（中性门落回上游文本，fail-safe）；
 * - install 幂等拒绝 / uninstall 清场（含编号窗口）。
 * 补丁侧的单行中性门本身不在此测（包内 js），由真机 e2e 复验兜底。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { GATE_KEY, installRequestImageHandleAnchor, uninstallRequestImageHandleAnchor } from '../imageHandleText'

const holder = globalThis as unknown as Record<string, ((version: unknown) => string | undefined) | undefined>

const version = (id: string, width = 750, height = 764) => ({
  attachment: { attachmentId: id },
  width,
  height
})

afterEach(() => {
  uninstallRequestImageHandleAnchor()
})

describe('request image handle short anchor gate', () => {
  it('installs once and rejects a second install', () => {
    expect(installRequestImageHandleAnchor()).toBe(true)
    expect(holder[GATE_KEY]).toBeTypeOf('function')
    expect(installRequestImageHandleAnchor()).toBe(false)
  })

  it('uninstall removes the gate and resets the numbering window', () => {
    installRequestImageHandleAnchor()
    const gate = holder[GATE_KEY]
    expect(gate?.(version('a'.repeat(64)))).toBe('图片1 (750x764px)')
    uninstallRequestImageHandleAnchor()
    expect(holder[GATE_KEY]).toBeUndefined()
    installRequestImageHandleAnchor()
    expect(holder[GATE_KEY]?.(version('b'.repeat(64)))).toBe('图片1 (750x764px)')
  })

  it('assigns first-seen indices and keeps them stable for the same attachment', () => {
    installRequestImageHandleAnchor()
    const gate = holder[GATE_KEY]
    expect(gate?.(version('a'.repeat(64)))).toBe('图片1 (750x764px)')
    expect(gate?.(version('b'.repeat(64), 640, 480))).toBe('图片2 (640x480px)')
    // 同图（可能跨多条消息/多轮重发）同号；尺寸随请求版本走。
    expect(gate?.(version('a'.repeat(64)))).toBe('图片1 (750x764px)')
    expect(gate?.(version('a'.repeat(64), 512, 512))).toBe('图片1 (512x512px)')
  })

  it('keeps at most a 32-image numbering window (evicted ids get a fresh index)', () => {
    installRequestImageHandleAnchor()
    const gate = holder[GATE_KEY]
    for (let i = 0; i < 32; i++) {
      expect(gate?.(version(String(i).padStart(64, '0'), 10, 10))).toBe(`图片${i + 1} (10x10px)`)
    }
    // 窗口满：最早插入的 id 0 被淘汰，新图拿 33 号，窗口内存活的 id 31 保持 32。
    expect(gate?.(version('f'.repeat(64), 20, 20))).toBe('图片33 (20x20px)')
    expect(gate?.(version(String(31).padStart(64, '0'), 10, 10))).toBe('图片32 (10x10px)')
    expect(gate?.(version('0'.padStart(64, '0'), 10, 10))).toBe(`图片${34} (10x10px)`)
  })

  it('returns undefined (upstream fallback) for unrecognized shapes and never throws', () => {
    installRequestImageHandleAnchor()
    const gate = holder[GATE_KEY]
    expect(gate?.(null)).toBeUndefined()
    expect(gate?.(undefined)).toBeUndefined()
    expect(gate?.({})).toBeUndefined()
    expect(gate?.({ attachment: {}, width: 750, height: 764 })).toBeUndefined()
    expect(gate?.({ attachment: { attachmentId: 'x' }, width: Number.NaN, height: 764 })).toBeUndefined()
    // 篡改 getter 逼出门内异常：门吞掉并落回 undefined，不外抛。
    const hostile = {
      get attachment(): never {
        throw new Error('boom')
      }
    }
    expect(() => gate?.(hostile)).not.toThrow()
    expect(gate?.(hostile)).toBeUndefined()
  })
})
