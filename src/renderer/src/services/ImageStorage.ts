import { loggerService } from '@logger'
import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import { convertToBase64 } from '@renderer/utils'

const logger = loggerService.withContext('ImageStorage')

const IMAGE_PREFIX = 'image://'

export default class ImageStorage {
  /**
   * 写入（upsert）。
   *
   * r2-08：此前分 add / update 两支，update 支是 `void db.settings.update(...)`——既不 await
   * 也不 catch：写失败变成 unhandled rejection，而 `set()` 在落库前就 resolve，紧跟其后的
   * `await ImageStorage.get(key)` 读回旧值（三个调用点都用读回值设置 UI）。`put` 本身就是
   * upsert，无需先 `get` 再分叉；单支 awaited 写 ⇒ 写后读回一定看到新值，失败也不会静默
   * （log + toast，CLAUDE.md §9）。
   */
  static async set(key: string, value: File | string): Promise<void> {
    const id = IMAGE_PREFIX + key
    try {
      if (typeof value === 'string') {
        // string（emoji）
        await db.settings.put({ id, value })
        return
      }

      // file image
      const base64Image = await convertToBase64(value)
      if (typeof base64Image === 'string') {
        await db.settings.put({ id, value: base64Image })
      }
    } catch (error) {
      logger.error('Error storing the image', error as Error)
      // 写失败必须有可见信号：调用方按「已保存」读回时拿到的会是旧值。
      window.toast.error(i18n.t('message.error.image_store_failed', { defaultValue: 'Failed to save the image.' }))
    }
  }

  /**
   * 读取。无记录时返回空串（r2-54：此前签名承诺 `string` 却在无记录时返回 `undefined`，
   * 调用方把 undefined 直接塞进 `setState`/渲染。这里按 finding 的第二方案统一归一化——
   * `''` 与「无记录」在渲染面等价，且 `set(key, '')` 本就是清除语义）。
   */
  static async get(key: string): Promise<string> {
    const id = IMAGE_PREFIX + key
    return (await db.settings.get(id))?.value ?? ''
  }

  static async remove(key: string): Promise<void> {
    const id = IMAGE_PREFIX + key
    try {
      const record = await db.settings.get(id)
      if (record) {
        await db.settings.delete(id)
      }
    } catch (error) {
      logger.error('Error removing the image', error as Error)
      throw error
    }
  }
}
