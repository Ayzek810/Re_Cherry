/**
 * 在途模型流切断的行为测试（v1）：
 * - 无人暂停：分片原样透传、登记在流终态注销（零行为差异）；
 * - 有人暂停：`abortTopicWork` 的中止信号必须真的到达下游请求（真切断，不是边界收尾）；
 * - 无会话身份的辅助调用：原样委托、不登记；
 * - 下游同步抛错：登记立刻撤销（不留悬空控制器）。
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { abortTopicWork, topicWorkCount } from '@main/services/topicWorkAbort'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wrapModelStream } from '../modelStreamAbort'

const TOPIC = 'topic-model-stream'

const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions =>
  ({ provider: 'p', model: 'm', messages: [], sessionId: TOPIC, ...extra }) as GenerateOptions

const text = (t: string): StreamChunk => ({ type: 'block-end', index: 0, block: { type: 'text', text: t } })

const collect = async (source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = []
  for await (const chunk of source) out.push(chunk)
  return out
}

async function* fromList(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

beforeEach(() => {
  // 工作表在模块级：清掉上一用例可能的残留（正常路径下应为空）。
  abortTopicWork(TOPIC)
})

describe('wrapModelStream（llm/stream 中间件）', () => {
  it('无人暂停：分片逐块原样透传，流结束后登记已注销', async () => {
    const next = vi.fn(() => fromList([text('a'), text('b')]))
    const source = wrapModelStream(options(), next)
    expect(topicWorkCount(TOPIC)).toBe(1)

    const chunks = await collect(source)

    expect(chunks.map((c) => (c.type === 'block-end' && c.block.type === 'text' ? c.block.text : ''))).toEqual([
      'a',
      'b'
    ])
    expect(topicWorkCount(TOPIC)).toBe(0)
  })

  it('暂停：abortTopicWork 的中止信号真的到达下游请求（HTTP 当场被掐，不是等边界）', async () => {
    let observedAbort = false
    const next = vi.fn((passed?: GenerateOptions) => {
      const signal = passed?.signal
      return (async function* () {
        // 模拟在途 HTTP：一直等，直到信号被中止。
        await new Promise<void>((_resolve, reject) => {
          if (signal === undefined) throw new Error('signal missing')
          if (signal.aborted) {
            observedAbort = true
            reject(signal.reason)
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
        yield text('never')
      })()
    })

    const source = wrapModelStream(options(), next)
    const pump = collect(source)
    expect(topicWorkCount(TOPIC)).toBe(1)

    const aborted = abortTopicWork(TOPIC, new Error('paused by user'))
    expect(aborted).toBe(1)

    await expect(pump).rejects.toThrow('paused by user')
    expect(observedAbort).toBe(true)
    // 终态注销：异常路径也必须撤登记。
    expect(topicWorkCount(TOPIC)).toBe(0)
  })

  it('调用方信号与我们的信号合成：调用方中止同样贯通，且登记随流终态注销', async () => {
    const caller = new AbortController()
    let seen: AbortSignal | undefined
    const next = vi.fn((passed?: GenerateOptions) => {
      seen = passed?.signal
      return fromList([text('x')])
    })

    const chunks = await collect(wrapModelStream(options({ signal: caller.signal }), next))

    expect(chunks).toHaveLength(1)
    expect(seen).not.toBe(caller.signal) // 合成信号而非原信号
    caller.abort()
    expect(seen?.aborted).toBe(true)
    expect(topicWorkCount(TOPIC)).toBe(0)
  })

  it('无会话身份的辅助调用：原样委托，不登记、不改参数', async () => {
    const next = vi.fn(() => fromList([text('title')]))
    const source = wrapModelStream(options({ sessionId: undefined }), next)

    await collect(source)

    expect(next).toHaveBeenCalledWith()
    expect(topicWorkCount(TOPIC)).toBe(0)
  })

  it('下游同步抛错：登记立刻撤销（不留悬空控制器）', () => {
    const next = vi.fn(() => {
      throw new Error('iterator construction failed')
    })

    expect(() => wrapModelStream(options(), next)).toThrow('iterator construction failed')
    expect(topicWorkCount(TOPIC)).toBe(0)
  })
})
