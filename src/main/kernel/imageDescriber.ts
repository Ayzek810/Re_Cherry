/**
 * 转述模型服务（ctx.imageDescriber 服务缝）。
 *
 * 持两份状态：当前配置的转述路由 (provider, model) 与自定义转述提示词，由渲染层
 * 经 IPC（Dsh_SyncImageDescriber）推送——settings 默认模型第三栏"转述模型"及其
 * 设置弹窗，同另两栏在引导页/设置页手动配置；未配置路由时 describe_images 不挂载，
 * 需要识图的主模型收到的只是 wire 占位文本。提示词为空字符串 = 内置默认
 * （@shared/config/imageDescriber 的 DEFAULT_IMAGE_DESCRIBE_PROMPT）。
 *
 * 会话状态一概不留：图片附件的真相源是会话日志（v0.3.1 user/message 的
 * image 内容块），describe_images 执行时按附件句柄在日志内反查
 * （见 describeImageTool.collectSessionImageRefs）——本服务不建并行登记表。
 *
 * 落缝方式：cordis `Service` 子类（`super(ctx, 'imageDescriber')`），
 * 与 dsh-attachment 的 AttachmentStore 同教义——直接给 ctx 赋属性会被
 * cordis 4 的声明制拒绝（"cannot set property ... without provide"）。
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'

const logger = loggerService.withContext('ImageDescriber')

/** 渲染层同步过来的转述路由（未配置 = undefined）。 */
export interface ImageDescriberRoute {
  provider: string
  model: string
}

/** ctx.imageDescriber 服务形状（IPC handler 与 describeImageTool 消费）。 */
export class ImageDescriberService extends Service {
  route: ImageDescriberRoute | undefined = undefined
  /** 自定义转述提示词；'' = 内置默认（describeImageTool 兜底）。 */
  prompt: string = ''

  constructor(ctx: Context) {
    super(ctx, 'imageDescriber')
  }

  setConfig(route: ImageDescriberRoute | undefined, prompt: string): void {
    const nextPrompt = typeof prompt === 'string' ? prompt : ''
    const changed =
      this.route?.provider !== route?.provider || this.route?.model !== route?.model || this.prompt !== nextPrompt
    if (!changed) return
    this.route = route
    this.prompt = nextPrompt
    logger.info('image describer config updated', {
      route: route === undefined ? null : { ...route },
      promptChars: nextPrompt.length
    })
  }
}

logger.debug('image describer module loaded')
