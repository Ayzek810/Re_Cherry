import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import { repairDsmlChunk } from '../dsmlRepair'

/** 真机泄漏样本形状：包裹标记 + invoke + arguments 参数。 */
const WRAPPED_LEAK = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="read">',
  '<｜DSML｜parameter name="arguments">{"path":"notes.txt"}</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>'
].join('\n')

function textBlockEnd(text: string, index = 0): StreamChunk {
  return { type: 'block-end', index, block: { type: 'text', text } }
}

describe('repairDsmlChunk', () => {
  it('把格式完好且参数合法的标记转成真 tool-call 块（正文剥离标记）', () => {
    const repaired = repairDsmlChunk(textBlockEnd(WRAPPED_LEAK, 2))
    expect(repaired).toBeDefined()
    const chunks = repaired as StreamChunk[]
    // 1 个正文 block-end + 每个调用 3 块（block-start / tool-call-delta / block-end）
    expect(chunks).toHaveLength(4)
    // 正文块被剥离成空（可能残留换行——与 v0.3.0 补丁逐字一致的语义）
    expect(chunks[0]).toMatchObject({ type: 'block-end', index: 2, block: { type: 'text' } })
    const strippedText = (chunks[0] as { block: { text: string } }).block.text
    expect(strippedText).not.toContain('DSML')
    expect(strippedText.trim()).toBe('')
    expect(chunks[1]).toEqual({ type: 'block-start', index: 3, blockType: 'tool-call' })
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', index: 3, name: 'read' })
    expect((chunks[2] as { argumentsDelta: string }).argumentsDelta).toBe('{"path":"notes.txt"}')
    expect(chunks[3]).toMatchObject({
      type: 'block-end',
      index: 3,
      block: { type: 'tool-call', name: 'read', arguments: '{"path":"notes.txt"}' }
    })
  })

  it('保留标记前后的正常正文，只剥离标记与包裹行', () => {
    const repaired = repairDsmlChunk(textBlockEnd(`我先读一下文件。\n${WRAPPED_LEAK}\n马上回来。`))
    const chunks = repaired as StreamChunk[]
    const text = (chunks[0] as { block: { text: string } }).block.text
    expect(text).toContain('我先读一下文件。')
    expect(text).toContain('马上回来。')
    expect(text).not.toContain('｜DSML｜')
    expect(text).not.toContain('\n\n\n')
  })

  it('一次泄漏多个调用时逐个转成成对块，index 递增', () => {
    const two = `${WRAPPED_LEAK}\n<｜DSML｜invoke name="grep">\n<｜DSML｜parameter name="arguments">{"pattern":"x"}</｜DSML｜parameter>\n</｜DSML｜invoke>`
    const chunks = repairDsmlChunk(textBlockEnd(two, 0)) as StreamChunk[]
    expect(chunks).toHaveLength(7)
    expect(chunks.slice(1).filter((chunk) => chunk.type === 'block-start')).toHaveLength(2)
    expect(chunks[1]).toMatchObject({ type: 'block-start', index: 1 })
    expect(chunks[4]).toMatchObject({ type: 'block-start', index: 2 })
    const ids = chunks.flatMap((chunk) => (chunk.type === 'tool-call-delta' ? [chunk.id] : []))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('参数不是合法 JSON 时原样透传（fail-safe，不猜）', () => {
    const badJson =
      '<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="arguments">{not json}</｜DSML｜parameter>\n</｜DSML｜invoke>'
    expect(repairDsmlChunk(textBlockEnd(badJson))).toBeUndefined()
  })

  it('标记残缺（缺结束标签）时原样透传', () => {
    const truncated =
      '<｜DSML｜invoke name="read">\n<｜DSML｜parameter name="arguments">{"path":"a"}</｜DSML｜parameter>'
    expect(repairDsmlChunk(textBlockEnd(truncated))).toBeUndefined()
  })

  it('普通文本不触发修复', () => {
    expect(repairDsmlChunk(textBlockEnd('这是一段普通回答，没有任何调用标记。'))).toBeUndefined()
  })

  it('只处理 block-end 文本块，不碰增量块与其他块型', () => {
    expect(repairDsmlChunk({ type: 'text-delta', index: 0, text: WRAPPED_LEAK })).toBeUndefined()
    expect(
      repairDsmlChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: WRAPPED_LEAK } })
    ).toBeUndefined()
    expect(repairDsmlChunk({ type: 'finish', reason: { kind: 'stop' } })).toBeUndefined()
  })
})
