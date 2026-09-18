/**
 * 助手标识（v0.3.1 功能一）：
 * 助手的"标识"是单一取值字段 `assistant.emoji` —— 从库里选的 emoji 和自己上传的图片都落在它身上，
 * 一条路径，不开第二条。所有展示位（左侧栏列表、话题页签、导航栏、设置弹窗标题、
 * 对话页"助手信息"挡）统一经 `AssistantAvatar` / 本模块的解析器取值。
 *
 * 图片形态：`img:<ImageStorage key>` —— 字段里只存短引用（随 Redux/localStorage 持久化），
 * 图片字节存 ImageStorage（Dexie settings 表，数据 URL）。
 * emoji 不可能是 ASCII 前缀，`img:` 前缀无碰撞。
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import { uuid } from '@renderer/utils'
import { compressImage } from '@renderer/utils/image'

import ImageStorage from './ImageStorage'

const logger = loggerService.withContext('AssistantIdentity')

/** `assistant.emoji` 以此开头 = 自定义图片标识，后缀为 ImageStorage 键。 */
export const IDENTITY_IMAGE_PREFIX = 'img:'

export const isImageIdentity = (value: string | undefined | null): value is string =>
  typeof value === 'string' && value.startsWith(IDENTITY_IMAGE_PREFIX)

export const identityImageKey = (value: string): string => value.slice(IDENTITY_IMAGE_PREFIX.length)

/**
 * 上传图片标识：GIF 直存（保留动画）；其余压缩到标识用途尺寸后入 ImageStorage，
 * 返回 `img:<key>` 引用。
 */
export async function createIdentityImage(file: File): Promise<string> {
  const stored = file.type === 'image/gif' ? file : await compressImage(file)
  const key = `assistant-identity:${uuid()}`
  await ImageStorage.set(key, stored)
  return IDENTITY_IMAGE_PREFIX + key
}

/** 读取图片标识的数据 URL；非图片引用 / 未找到 / 读取失败 → undefined。 */
export async function getIdentityImage(value: string | undefined | null): Promise<string | undefined> {
  if (!isImageIdentity(value)) return undefined
  try {
    const dataUrl = await ImageStorage.get(identityImageKey(value))
    return dataUrl || undefined
  } catch (error) {
    logger.warn('Failed to read identity image', error as Error)
    return undefined
  }
}

/**
 * 替换 / 清除图片标识后回收旧对象：仅当再无任何助手（含默认助手、预设）引用同一图片时才删。
 * 失败只记日志——遗留的孤儿条目无害。
 */
export async function releaseIdentityImage(ref: string | undefined | null): Promise<void> {
  if (!isImageIdentity(ref)) return
  try {
    const { assistants, defaultAssistant } = store.getState().assistants
    if ([defaultAssistant, ...assistants].some((a) => a?.emoji === ref)) return
    await ImageStorage.remove(identityImageKey(ref))
  } catch (error) {
    logger.warn('Failed to release identity image', error as Error)
  }
}
