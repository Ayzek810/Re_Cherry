/**
 * generate_image 内核工具机测：双门登记语义（每轮 setTurnGenerateImageConfig
 * 写入/清除）+ 执行链（未登记如实报错 / 参数钳制 / lightGenerateImage 透传）。
 * lightLlmModalities 整体 mock（路由与 fetch 已有自己的机测，不重复）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GenerateImageToolModule from '../generateImageTool'

const lightGenerateImageMock = vi.fn()

vi.mock('../lightLlmModalities', () => ({
  lightGenerateImage: (...args: unknown[]) => lightGenerateImageMock(...args)
}))

type ExecLike = { agent?: { session?: { id?: string } } }

async function loadTool() {
  return await import('../generateImageTool')
}

describe('generate_image 工具', () => {
  beforeEach(() => {
    lightGenerateImageMock.mockReset()
    lightGenerateImageMock.mockResolvedValue({ type: 'base64', images: ['data:image/png;base64,aGk='] })
  })

  it('未登记轮执行：如实报可行动错误（不静默降级）', async () => {
    const tool = await loadTool()
    const exec = { agent: { session: { id: 'topic-a' } } } as unknown as ExecLike
    await expect(
      tool.apply === undefined ? Promise.reject(new Error('no apply')) : runExecute(tool, exec, { prompt: 'x', imageSize: '1024x1024', count: 1 })
    ).rejects.toThrow('no painting model registered')
  })

  it('登记后执行：参数钳制（count 1-4）并透传给 lightGenerateImage', async () => {
    const tool = await loadTool()
    tool.setTurnGenerateImageConfig('topic-b', { providerId: 'p', modelId: 'm' })
    const exec = { agent: { session: { id: 'topic-b' } } } as unknown as ExecLike
    const result = (await runExecute(tool, exec, { prompt: 'a cat', imageSize: '512x512', count: 99 })) as {
      count: number
      images: string[]
    }
    expect(lightGenerateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'p', model: 'm', prompt: 'a cat', imageSize: '512x512', batchSize: 4 })
    )
    expect(result.count).toBe(1)
    expect(result.images).toEqual(['data:image/png;base64,aGk='])
    tool.setTurnGenerateImageConfig('topic-b', undefined)
  })

  it('清除登记后再次执行：报错（每轮登记语义）', async () => {
    const tool = await loadTool()
    tool.setTurnGenerateImageConfig('topic-c', { providerId: 'p', modelId: 'm' })
    tool.setTurnGenerateImageConfig('topic-c', undefined)
    const exec = { agent: { session: { id: 'topic-c' } } } as unknown as ExecLike
    await expect(runExecute(tool, exec, { prompt: 'x', imageSize: '1024x1024', count: 1 })).rejects.toThrow(
      'no painting model registered'
    )
  })
})

/** defineTool 的 execute 闭包不直接导出——经 apply 注册到假 ToolRuntime 后触发。 */
async function runExecute(tool: typeof GenerateImageToolModule, exec: ExecLike, args: Record<string, unknown>) {
  let captured:
    | { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }
    | undefined
  const fakeTools = {
    register: (definition: { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }) => {
      captured = definition
    }
  }
  const fakeCtx = { tools: fakeTools }
  tool.apply(fakeCtx as never)
  if (captured === undefined) throw new Error('tool was not registered')
  return await captured.execute(args, exec)
}
