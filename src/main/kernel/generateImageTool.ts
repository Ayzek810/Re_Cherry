/**
 * generate_image 内核 builtin 工具（v0.3.3 批次5，V2 PaintingTool 同构）。
 *
 * 对话模型经 tool call 出图：执行 = 轻量 AI 服务面 lightGenerateImage
 * （lightLlmModalities 直调，主进程内无 IPC）；独立绘画模型出图，不用对话模型
 * 本体（V2 语义：capabilities 原生图像输出禁用，一律走工具）。挂载门（渲染层
 * messageThunk，照 V2 PaintingTool.applies 双门）：助手 enableGenerateImage 开
 * 且绘画模型已配置的轮，把 'generate_image' 并入 builtinTools；每轮绘画模型经
 * sendMessage options.generateImage 登记（webSearch 同构）。未登记时执行侧如实
 * 报可行动错误，不静默降级。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { lightGenerateImage } from './lightLlmModalities'

const logger = loggerService.withContext('GenerateImageTool')

export const name = 'tool-generate-image'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Generate images from a text prompt using the dedicated painting model configured by the user. ' +
  'Use this when the user asks to create, draw or generate an image/picture/poster. ' +
  'Returns the generated images as attachments in this conversation turn. ' +
  'If the tool is unavailable the user has not enabled or configured it — say so instead of retrying.'

/** 每轮登记的绘画模型（sendMessage options.generateImage；webSearch 同构）。 */
interface GenerateImageTurnConfig {
  providerId: string
  modelId: string
}

/** 每轮登记表（turnKey → 配置；sendMessage 时写入，轮结束由内核回收）。 */
const turnConfigs = new Map<string, GenerateImageTurnConfig>()

/** 渲染层 sendMessage 薄转发入口（kernel/index.ts handler 调用）。 */
export function setTurnGenerateImageConfig(turnKey: string, config: GenerateImageTurnConfig | undefined): void {
  if (config === undefined) {
    turnConfigs.delete(turnKey)
  } else {
    turnConfigs.set(turnKey, config)
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description: DESCRIPTION,
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Image description. Write a detailed visual prompt: subject, style, composition, colors.'
        },
        imageSize: {
          type: 'string',
          required: true,
          description: 'Output size as WIDTHxHEIGHT (e.g. "1024x1024"). Use "1024x1024" when unsure.'
        },
        count: {
          type: 'number',
          required: true,
          description: 'Number of images to generate, 1-10. Use 1 when unsure.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', required: true },
            count: { type: 'number', required: true },
            images: { type: 'array', items: { type: 'string' }, required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `Generated ${value.count} image(s) for: ${value.prompt}` }],
        // 批次5 投影通道（webSearch presentationMeta 同构）：结构化图片列表随
        // tool/result 事件 meta 上行——内核正规通道，持久化、回放复现。渲染层
        // kernelChat 读 event.data.meta.kind === 'generate-image' 建 IMAGE 块。
        // 不走 tool/result 文本（那是 render 的人读句子，非 JSON）。
        presentationMeta: (_args, value) => ({
          kind: 'generate-image',
          images: value.images ?? []
        })
      },
      // 生成请求不并发安全（同 ocr_document：单活请求语义）——DSH 串行执行。
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const prompt = String(args.prompt ?? '').trim()
        if (prompt.length === 0) {
          throw new Error('generate_image: empty prompt')
        }
        const turnKey = exec.agent?.session?.id
        if (turnKey === undefined) {
          throw new Error('generate_image: no active conversation turn')
        }
        const config = turnConfigs.get(turnKey)
        if (config === undefined) {
          throw new Error(
            'generate_image: no painting model registered for this turn. Ask the user to configure one in Settings → Paintings and enable image generation for this assistant.'
          )
        }
        const imageSize =
          typeof args.imageSize === 'string' && args.imageSize.trim().length > 0 ? args.imageSize.trim() : '1024x1024'
        const batchSizeRaw = Number(args.count ?? 1)
        const batchSize = Number.isFinite(batchSizeRaw) ? Math.min(10, Math.max(1, Math.floor(batchSizeRaw))) : 1
        const requestId = `generate-image:${turnKey}:${Date.now()}`
        const result = await lightGenerateImage({
          provider: config.providerId,
          model: config.modelId,
          prompt,
          // fork 缝（v0.3.3 批次6）：工具无目录信息，只下发两个基础键；主进程按
          // provider 的 wire profile 改名（diffusion 档），与旧行为等价。
          paramValues: { size: imageSize, numImages: batchSize },
          requestId
        })
        logger.info(`generate_image: ${result.images.length} image(s) via ${config.modelId}`)
        return {
          prompt,
          count: result.images.length,
          images: result.images
        }
      }
    })
  )
}
