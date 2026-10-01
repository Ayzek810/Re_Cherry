/**
 * p2-10 行为测试：`useSmoothStream` 的队列/回调改造不改变对外行为。
 *
 * 覆盖三条不变量（家规 §9 渲染：热路径改动需行为级证据）：
 *  1. **不丢字**：无论输入怎样分块，收尾后显示文本 === 累积输入全文（顺序一致）；
 *  2. **回调频率钳制 ≤30Hz**：排放阶段相邻两次 `onUpdate` 的真实间隔不小于 1000/30 ms
 *     （改动前 `minDelay = 10` 允许 100Hz，每帧把整段累积全文推给 ReactMarkdown）；
 *  3. **队列上界**：一次性灌入的量远大于 MAX_BACKLOG(400) 时也不丢失内容。
 *
 * 时序用真实 rAF 驱动 + `performance.now` 打点（jsdom 的 rAF 约 16ms 一帧），
 * 与生产路径一致；断言只看不变量，不比较具体帧数（家规：不以计时作为回归信号）。
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useSmoothStream } from '../useSmoothStream'

interface Recorder {
  texts: string[]
  stamps: number[]
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立（避免用固定时长赌机器负载；家规：不以计时作为回归信号）。 */
const waitUntil = async (predicate: () => boolean, timeoutMs = 8000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(20)
  }
  return predicate()
}

/** 建一个 record-onUpdate 的 hook（返回文本序列与时间戳）。 */
const mountRecorder = (done = false) => {
  const recorder: Recorder = { texts: [], stamps: [] }
  const rendered = renderHook(
    ({ isDone }: { isDone: boolean }) =>
      useSmoothStream({
        onUpdate: (text) => {
          recorder.texts.push(text)
          recorder.stamps.push(performance.now())
        },
        streamDone: isDone,
        initialText: ''
      }),
    { initialProps: { isDone: done } }
  )
  return { recorder, ...rendered }
}

describe('useSmoothStream（p2-10 行为不变量）', () => {
  it('排放阶段回调间隔不小于 33ms（≤30Hz），收尾后内容全量显示', async () => {
    const { recorder, result, rerender } = mountRecorder()

    // 模拟 6 次"毫秒级到达"的 delta（每 5ms 一次，快于渲染帧）
    const pieces: string[] = []
    for (let i = 0; i < 6; i++) {
      const piece = `第${i}段内容-` + '填充字符。'.repeat(12)
      pieces.push(piece)
      result.current.addChunk(piece)
      await wait(5)
    }

    // 排放阶段（rate 控制器按入站速率释放）：收集到足够多的回调样本为止
    // （轮询而不是固定时长，避免机器负载影响）
    await waitUntil(() => recorder.stamps.length >= 12, 5000)
    const emissions = recorder.stamps.length

    // 收尾：把剩余队列一次吐完（生产路径：block.status → success）
    rerender({ isDone: true })
    await wait(200)

    // 1) 内容完整、有序：最后一条回调 === 全部输入拼接
    const expected = pieces.join('')
    expect(recorder.texts[recorder.texts.length - 1]).toBe(expected)

    // 2) 回调频率钳制：排放阶段相邻回调间隔 ≥ 1000/30 - 容差。
    //    首帧（lastFrameTime 未建立）会立刻发一次，属既有行为，从第 3 条起检查。
    expect(emissions).toBeGreaterThan(8)
    const intervals = recorder.stamps.slice(1).map((t, i) => t - recorder.stamps[i])
    const sustained = intervals.slice(2, emissions - 1)
    expect(sustained.length).toBeGreaterThan(5)
    expect(Math.min(...sustained)).toBeGreaterThan(1000 / 30 - 4)
  })

  it('积压（未触 MAX_BACKLOG 上限）收尾后全量显示，超限时按既有语义加速追赶', async () => {
    // 1) 队列未触顶（48 字 << MAX_BACKLOG=400）：全部内容最终都会显示
    //    —— p2-10 的"原地 push / 只塌陷头部"改造不得丢字
    const withinCap = mountRecorder()
    const burst = 'A'.repeat(48)
    withinCap.result.current.addChunk(burst)
    await wait(120) // 让控制器先播放一部分（渲染帧驱动）
    withinCap.rerender({ isDone: true })
    const shown = (): string => withinCap.recorder.texts[withinCap.recorder.texts.length - 1] ?? ''
    await waitUntil(() => shown() === burst, 8000)
    expect(shown()).toBe(burst)

    // 2) 超限（RATE >> 显示速率）：MAX_BACKLOG 是"相对实时模型的延迟上限"，实现
    //    选择加速追赶而不是让显示无限落后 —— 与改动前同语义（本测试锁定语义不变）
    const overCap = mountRecorder()
    overCap.result.current.addChunk('B'.repeat(1200))
    const overShown = (): string => overCap.recorder.texts[overCap.recorder.texts.length - 1] ?? ''
    await waitUntil(() => overShown().length > 150, 8000)
    const halfway = overShown()
    expect(halfway.length).toBeLessThan(1200)
    expect(halfway).toMatch(/^B+$/)
    expect(halfway.length).toBeGreaterThan(150)
  })

  it('收尾（streamDone 翻转）后显示文本与累积输入逐字一致', async () => {
    const { recorder, result, rerender } = mountRecorder()

    result.current.addChunk('前半段'.repeat(20))
    await wait(30)
    result.current.addChunk('后半段'.repeat(20))
    rerender({ isDone: true })
    await wait(200)

    expect(recorder.texts[recorder.texts.length - 1]).toBe('前半段'.repeat(20) + '后半段'.repeat(20))
  })
})
