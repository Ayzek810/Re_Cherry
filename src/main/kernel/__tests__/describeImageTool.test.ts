import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import {
  apply,
  collectSessionImageRefs,
  DESCRIBE_IMAGE_PROMPT,
  resolveAttachmentRef,
  wireHandle
} from '../describeImageTool'
import type { ImageDescriberService } from '../imageDescriber'

/**
 * describe_images 工具机测：真 defineTool + 真 BlockAssembler，只 fake
 * ctx.llm / ctx.attachments / ctx.imageDescriber 与 exec.agent.session。
 * 钉住的语义：
 *   - 会话日志反查：真实用户轮的 image ref 进候选；plugin 注入的 user/message
 *     带图也不算用户附件；非 user/message 事件不进候选；重复 ref 去重
 *   - 路由防线（反向控制探针①）：主模型声明 image 输入 → 拒绝执行
 *   - 参数防线（探针②③）：非附件引用 / 前缀无匹配 → 具名错误
 *   - 快乐路径：describer 单次往返，OCR 提示词作 system，图片块随请求上行
 */

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

function makeRef(hex: string, name?: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(hex),
    mediaType: 'image/png',
    bytes: 1111,
    width: 64,
    height: 64,
    ...(name === undefined ? {} : { name })
  } as ImageAttachmentRef
}

const REF_A = makeRef(HEX_A, 'cat.png')
const REF_B = makeRef(HEX_B)

function userMessageEvent(
  content: unknown[],
  source: { kind: string; plugin?: string } = { kind: 'user' }
): SessionEvent {
  return { type: 'user/message', data: { content, source } } as unknown as SessionEvent
}

describe('collectSessionImageRefs', () => {
  it('收集真实用户轮的图片 ref，去重且保持顺序', () => {
    const events = [
      userMessageEvent([
        { type: 'text', text: 'hi' },
        { type: 'image', attachment: REF_A }
      ]),
      { type: 'assistant/message', data: {} },
      userMessageEvent([
        { type: 'image', attachment: REF_A },
        { type: 'image', attachment: REF_B }
      ])
    ] as unknown as SessionEvent[]
    expect(collectSessionImageRefs(events)).toEqual([REF_A, REF_B])
  })

  it('plugin 注入的 user/message 带图不算用户附件', () => {
    const events = [
      userMessageEvent([{ type: 'image', attachment: REF_B }], { kind: 'plugin', plugin: 'x' }),
      userMessageEvent([{ type: 'text', text: 'yo' }])
    ] as unknown as SessionEvent[]
    expect(collectSessionImageRefs(events)).toEqual([])
  })

  it('无 user/message 或空日志返回空数组', () => {
    expect(collectSessionImageRefs(undefined)).toEqual([])
    expect(collectSessionImageRefs([{ type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent])).toEqual([])
  })
})

describe('resolveAttachmentRef / wireHandle', () => {
  // 非均匀 hex：把三种形态区分开（开头 8 位 ≠ wire 占位中段）
  const HEX_C = '0123456789abcdef'.repeat(4) // 64 hex
  const REF_C = makeRef(HEX_C)

  it('wireHandle 与 dsh-llm 占位文本同源（hex 第 7..14 位）', () => {
    expect(wireHandle(REF_C)).toBe(HEX_C.slice(7, 15)) // '789abcde'
    expect(wireHandle(REF_C)).not.toBe(HEX_C.slice(0, 8)) // ≠ '01234567'
  })

  it('三形态各自治愈：完整 id / 开头前缀 / 占位中段片段', () => {
    const refs = [REF_A, REF_C]
    expect(resolveAttachmentRef(HEX_C, refs)).toBe(REF_C) // ① 完整 64 位
    expect(resolveAttachmentRef('01234567', refs)).toBe(REF_C) // ② 开头前缀
    expect(resolveAttachmentRef('789abcde', refs)).toBe(REF_C) // ③ wire 占位中段（最常见：模型照占位文本抄）
  })

  it('无匹配返回 undefined（不猜最近值）', () => {
    expect(resolveAttachmentRef('f'.repeat(8), [REF_A, REF_C])).toBeUndefined()
  })
})

interface ExecLike {
  agent?: {
    session: {
      events: readonly SessionEvent[]
      requestHeader: () => { config?: { provider?: string; model?: string } } | undefined
    }
    options: { provider?: string; model?: string }
  }
  signal?: AbortSignal
}

function makeCtx(options: {
  modalities?: readonly string[]
  chunks?: StreamChunk[]
  route?: { provider: string; model: string } | null
  prompt?: string
  readImage?: (ref: ImageAttachmentRef) => Promise<unknown>
}): { ctx: Context; captured: Array<{ system?: string; messages: unknown[]; provider: string; model: string }> } {
  const captured: Array<{ system?: string; messages: unknown[]; provider: string; model: string }> = []
  const chunks = options.chunks ?? []
  // 普通对象按 ImageDescriberService 使用（工具只读 .route/.prompt；不真 new——
  // cordis Service 构造器要摸真实 ctx 内部）。prompt：'' = 内置默认。
  const describer = {
    route: options.route === null ? undefined : (options.route ?? { provider: 'siliconflow', model: 'qwen-vl' }),
    prompt: options.prompt ?? ''
  } as unknown as ImageDescriberService
  const ctx = {
    imageDescriber: describer,
    attachments: { readImage: options.readImage ?? (async () => ({ ref: null, data: null })) },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: options.modalities ?? ['text'] }),
      stream: async function* (call: { system?: string; messages: unknown[]; provider: string; model: string }) {
        captured.push(call)
        for (const chunk of chunks) yield chunk
      }
    }
  } as unknown as Context
  return { ctx, captured }
}

function execWith(events: readonly SessionEvent[]): ExecLike {
  return {
    agent: {
      session: {
        events,
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } })
      },
      options: { provider: 'p', model: 'm' }
    },
    signal: new AbortController().signal
  }
}

async function registeredTool(ctxObj: object): Promise<{
  execute: (args: unknown, exec: ExecLike) => Promise<unknown>
}> {
  const tools: Array<{ name: string; execute(a: unknown, e: ExecLike): Promise<unknown> }> = []
  const ctx = { ...ctxObj, tools: { register: (t) => void tools.push(t) } } as unknown as Context
  apply(ctx)
  const tool = tools.find((t) => t.name === 'describe_images')
  if (tool === undefined) throw new Error('describe_images not registered')
  return { execute: tool.execute }
}

const textChunk = (index: number, text: string): StreamChunk => ({ type: 'text-delta', index, text })
const finishStop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

describe('describe_images execute', () => {
  const events = [
    userMessageEvent([
      { type: 'text', text: 'look' },
      { type: 'image', attachment: REF_A }
    ])
  ] as unknown as SessionEvent[]

  it('快乐路径：按占位前缀反查日志，describer 单次往返，OCR 提示词作 system', async () => {
    const { ctx, captured } = makeCtx({
      modalities: ['text'],
      chunks: [textChunk(0, '一张猫的照片'), finishStop]
    })
    const { execute } = await registeredTool(ctx)
    const result = (await execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))) as {
      attachment: string
      description: string
    }
    expect(result.attachment).toBe(HEX_A.slice(7, 15))
    expect(result.description).toBe('一张猫的照片')
    // describer 调用形状：OCR 提示词作 system；user 消息含 text + image 块
    expect(captured).toHaveLength(1)
    expect(captured[0].system).toBe(DESCRIBE_IMAGE_PROMPT)
    expect(captured[0].model).toBe('qwen-vl')
    const message = captured[0].messages[0] as { content: unknown[]; source: { kind: string; plugin: string } }
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'describe-image' })
    expect(message.content).toHaveLength(2)
    expect((message.content[0] as { type: string }).type).toBe('text')
    expect((message.content[1] as { type: string }).type).toBe('image')
  })

  it('自定义转述提示词（设置弹窗推送）覆盖内置默认；空串回落默认', async () => {
    const custom = 'MY CUSTOM PROMPT'
    const withCustom = makeCtx({
      chunks: [textChunk(0, 'ok'), finishStop],
      prompt: custom
    })
    const toolA = await registeredTool(withCustom.ctx)
    await toolA.execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))
    expect(withCustom.captured[0].system).toBe(custom)
    // 空 prompt（默认态）→ 内置 OCR 提示词
    const withDefault = makeCtx({ chunks: [textChunk(0, 'ok'), finishStop] })
    const toolB = await registeredTool(withDefault.ctx)
    await toolB.execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))
    expect(withDefault.captured[0].system).toBe(DESCRIBE_IMAGE_PROMPT)
  })

  it('反向探针①：主模型声明 image 输入（视觉路由）→ 拒绝执行', async () => {
    const { ctx } = makeCtx({ modalities: ['text', 'image'], chunks: [finishStop] })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))).rejects.toThrow(
      /declares image input/
    )
  })

  it('反向探针②：参数不是附件引用形态 → 具名错误', async () => {
    const { ctx } = makeCtx({ chunks: [finishStop] })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: '随便一段话' }, execWith(events))).rejects.toThrow(
      /is not an attachment reference/
    )
  })

  it('反向探针③：前缀在日志内无匹配（含可用列表报文）→ 具名错误', async () => {
    const { ctx } = makeCtx({ chunks: [finishStop] })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: 'sha256:cccccccc' }, execWith(events))).rejects.toThrow(
      /no attached image matches "sha256:cccccccc" \(available attachments: aaaaaaaa\)/
    )
  })

  it('反向探针④：转述路由未配置 → 具名错误', async () => {
    const { ctx } = makeCtx({ route: null, chunks: [finishStop] })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))).rejects.toThrow(
      /no image describer model is configured/
    )
  })

  it('describer 回空文本 → 具名错误（不静默返回空描述）', async () => {
    const { ctx } = makeCtx({ chunks: [finishStop] })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))).rejects.toThrow(
      /returned empty text/
    )
  })

  it('describer 流失败 → 错误信息透传', async () => {
    const { ctx } = makeCtx({
      chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } as StreamChunk]
    })
    const { execute } = await registeredTool(ctx)
    await expect(execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))).rejects.toThrow(
      /describer model failed: boom/
    )
  })

  it('名称随消息上行（有名字的图）', async () => {
    const { ctx, captured } = makeCtx({ chunks: [textChunk(0, 'ok'), finishStop] })
    const { execute } = await registeredTool(ctx)
    await execute({ attachment: `sha256:${HEX_A.slice(0, 8)}` }, execWith(events))
    const textBlock = (captured[0].messages[0] as { content: Array<{ type: string; text?: string }> }).content[0]
    expect(textBlock.text).toContain('cat.png')
  })
})
