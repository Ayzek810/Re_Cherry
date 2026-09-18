/**
 * describe_images 工具（无视觉模型的识图通道）：
 * 主模型不声明 image 输入的轮里，让一个配置好的视觉模型（"转述模型"，settings -·
 * 默认模型第三栏）把指定图片转述成文字（OCR 提示词），结果作为纯文本回给主模型。
 * 主模型有视觉时本工具永不挂载（发送链按路由判定），执行侧保留防线拒绝
 * （仿 read_image 的 assertImageCapableRoute 双层门）。
 *
 * 机制：dsh 在 wire 上把纯文本路由的图片块降级为
 * "[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]"
 * 占位文本——模型看到占位即知有图，抄其中的 8 位 sha 前缀调本工具取内容。
 * 图片的完整 ref 存在会话日志里（v0.3.1 识图通道：user/message 内容块），
 * 是唯一真相源——本工具按前缀在日志内反查，不建任何并行登记表；
 * 历史任意轮的图都可被转述（占位文本在 wire 上随历史常驻，模型自然可指）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'
import { DEFAULT_IMAGE_DESCRIBE_PROMPT } from '@shared/config/imageDescriber'

import type { ImageDescriberService } from './imageDescriber'

const logger = loggerService.withContext('DescribeImageTool')

/**
 * 转述提示词的内置默认：只转录与描述可见内容（不解读、不翻译）。用户裁决原文。
 * 用户自定义时以 ImageDescriberService.prompt 覆盖（设置页转述模型设置弹窗）。
 */
export const DESCRIBE_IMAGE_PROMPT = DEFAULT_IMAGE_DESCRIBE_PROMPT

export const name = 'tool-describe-images'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制，
// 漏声明在运行期才炸——"cannot get property ... without inject"，boot 不报错）。
// 四者 boot 时全部已启动，此处声明无等待风险。
export const inject = ['tools', 'imageDescriber', 'llm', 'attachments']

const DESCRIPTION =
  'Transcribe one attached image into plain text, by routing it through a vision-capable describer model. ' +
  'Use this whenever image references appear in the conversation (they look like ' +
  '"[image omitted ...; attachment sha256:xxxxxxxx]") and you need their actual visual content: text in the ' +
  'image, icons, layout, positions. Pass the attachment reference exactly as shown beside the omitted image ' +
  '(the sha256:... part). The output is transcription and visible structure only — it does not interpret or translate.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'describe_images',
      description: DESCRIPTION,
      parameters: {
        attachment: {
          type: 'string',
          required: true,
          description:
            'The attachment reference of the image to describe — the "sha256:xxxxxxxx" value shown beside the omitted image placeholder.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachment: { type: 'string', required: true },
            description: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `[${value.attachment}] ${value.description}` }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const describer = (ctx as unknown as { imageDescriber?: ImageDescriberService }).imageDescriber
        if (describer === undefined) {
          throw new Error('describe_images: no describer service is mounted')
        }
        // ---- 0. 转述路由必须已配置（渲染层 Settings 默认模型第三栏经 IPC 推送） ----
        const route = describer.route
        if (route === undefined) {
          throw new Error('describe_images: no image describer model is configured')
        }
        // ---- 1. 双层门第二层（防线，仿 read_image 的 assertImageCapableRoute）： ----
        // ---- 主模型有视觉时本工具不该被调（渲染层发送链已挡） ----
        const routed = exec.agent?.session.requestHeader()?.config
        const provider = routed?.provider ?? exec.agent?.options.provider
        const model = routed?.model ?? exec.agent?.options.model
        if (provider !== undefined && model !== undefined) {
          const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
          if (info.inputModalities !== undefined && info.inputModalities.includes('image')) {
            throw new Error(`describe_images: model "${model}" declares image input — read the images directly instead`)
          }
        }
        // ---- 2. 会话日志反查（唯一真相源；无任何并行登记表） ----
        const refs = collectSessionImageRefs(exec.agent?.session.events)
        const raw = String(args.attachment ?? '').trim()
        // 兼容模型连 "sha256:" 前缀一起抄或只抄 hex 两种形态
        const prefix = raw.replace(/^sha256:/i, '').toLowerCase()
        if (!/^[0-9a-f]{4,64}$/.test(prefix)) {
          throw new Error(
            `describe_images: "${raw}" is not an attachment reference (it should look like sha256:xxxxxxxx from beside an omitted image)`
          )
        }
        const ref = resolveAttachmentRef(prefix, refs)
        if (ref === undefined) {
          const available =
            refs.length === 0
              ? 'no images are attached in this conversation'
              : `available attachments: ${refs.map((r) => wireHandle(r)).join(', ')}`
          throw new Error(`describe_images: no attached image matches "${raw}" (${available})`)
        }
        // ---- 3. 核验性读取（存在 + digest；ENOENT 即明错） ----
        await ctx.attachments.readImage(ref, exec.signal)
        // ---- 4. 转述模型一次往返：图 + 转述提示词（ctx.llm 公共 seam） ----
        // 用户自定义提示词优先（设置页转述模型弹窗推送）；空 = 内置 OCR 默认。
        const describePrompt = describer.prompt.length > 0 ? describer.prompt : DESCRIBE_IMAGE_PROMPT
        const focus = typeof ref.name === 'string' && ref.name.length > 0 ? `\nThe file name is "${ref.name}".` : ''
        const message = createUserMessage({
          content: [
            { type: 'text', text: `Describe this image.${focus}` },
            // ImageBlock 形状 = { type:'image', attachment: ImageAttachmentRef }——
            // 原样传完整 ref；mediaType 定扩展名，bytes/digest 与发送链同源。
            { type: 'image' as const, attachment: ref }
          ],
          source: { kind: 'plugin', plugin: 'describe-image' }
        })
        const assembler = new BlockAssembler()
        for await (const chunk of ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: describePrompt,
          messages: [message],
          maxTokens: 4096
        })) {
          assembler.push(chunk)
        }
        const finish = assembler.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          const failure = finish.failure as { message?: string } | undefined
          throw new Error(`describe_images: describer model failed: ${failure?.message ?? finish.kind}`)
        }
        const text = assembler
          .blocks()
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
          .trim()
        if (text.length === 0) {
          throw new Error(`describe_images: describer returned empty text for ${wireHandle(ref)}`)
        }
        logger.info('describe_images: transcribed one image', {
          attachment: wireHandle(ref),
          chars: text.length
        })
        return { attachment: wireHandle(ref), description: text }
      }
    })
  )
}

/**
 * 从会话日志收集全部真实用户轮的图片 ref（附件引用的真相源）。
 * 'user/message' 事件的 data 即 UserMessage（content + source）；工具结果走独立的
 * 'tool/result' 事件，不在此列。插件注入的 user/message（source.kind:'plugin'）
 * 即便带图也不属于用户附件，不进候选。
 */
export function collectSessionImageRefs(events: readonly SessionEvent[] | undefined): ImageAttachmentRef[] {
  if (events === undefined) return []
  const out: ImageAttachmentRef[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    for (const block of event.data.content) {
      if (block.type === 'image' && !out.includes(block.attachment)) {
        out.push(block.attachment)
      }
    }
  }
  return out
}

/**
 * wire 占位文本里的附件句柄（与 dsh-llm textOnlyImageText 同源：
 * `sha256:${hex 第 7..14 位}`——中段片段，模型照占位文本原样抄回来）。
 */
export function wireHandle(ref: ImageAttachmentRef): string {
  return String(ref.attachmentId).slice(7, 15)
}

/**
 * 三形态解析模型回传的附件引用：
 * ① 完整 64 位 hex（模型抄了全 id）；② 开头前缀（直觉形态）；
 * ③ wire 占位片段（最常见：模型从占位文本照抄 slice(7,15) 中段）。
 * 内容寻址（sha256）下三态歧义概率可忽略。
 */
export function resolveAttachmentRef(
  prefix: string,
  refs: readonly ImageAttachmentRef[]
): ImageAttachmentRef | undefined {
  const p = prefix.toLowerCase()
  return (
    refs.find((r) => String(r.attachmentId).toLowerCase() === p) ??
    refs.find((r) => String(r.attachmentId).toLowerCase().startsWith(p)) ??
    refs.find((r) => wireHandle(r).toLowerCase() === p)
  )
}
