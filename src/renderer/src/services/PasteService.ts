import { loggerService } from '@logger'
import type { FileMetadata } from '@renderer/types'
import { getFileExtension, isSupportedFile } from '@renderer/utils'

const logger = loggerService.withContext('PasteService')

// Track last focused component
type ComponentType = 'inputbar' | 'messageEditor' | null
let lastFocusedComponent: ComponentType = 'inputbar' // Default to inputbar

// 处理函数类型
type PasteHandler = (event: ClipboardEvent) => Promise<boolean>

// 处理函数存储
const handlers: {
  inputbar?: PasteHandler
  messageEditor?: PasteHandler
} = {}

/**
 * 处理粘贴事件的通用服务
 * 处理各种粘贴场景，包括文本和文件
 */
export const handlePaste = async (
  event: ClipboardEvent,
  supportExts: string[],
  setFiles: (updater: (prevFiles: FileMetadata[]) => FileMetadata[]) => void,
  setText?: (text: string) => void,
  pasteLongTextAsFile?: boolean,
  pasteLongTextThreshold?: number,
  text?: string,
  resizeTextArea?: () => void,
  t?: (key: string) => string
): Promise<boolean> => {
  try {
    // 优先处理文本粘贴
    const clipboardText = event.clipboardData?.getData('text')
    if (clipboardText) {
      // 1. 文本粘贴
      if (pasteLongTextAsFile && pasteLongTextThreshold && clipboardText.length > pasteLongTextThreshold) {
        // 长文本直接转文件，阻止默认粘贴
        event.preventDefault()

        const tempFilePath = await window.api.file.createTempFile('pasted_text.txt')
        await window.api.file.write(tempFilePath, clipboardText)
        const selectedFile = await window.api.file.get(tempFilePath)
        if (selectedFile) {
          setFiles((prevFiles) => [...prevFiles, selectedFile])
          if (setText && text) setText(text) // 保持输入框内容不变
          if (resizeTextArea) setTimeout(() => resizeTextArea(), 50)
        }
        return true
      }
      // 短文本走默认粘贴行为，直接返回
      return false
    }
    // 2. 文件/图片粘贴（仅在无文本时处理）
    if (event.clipboardData?.files && event.clipboardData.files.length > 0) {
      event.preventDefault()
      const extensionSet = new Set(supportExts)
      try {
        for (const file of event.clipboardData.files) {
          // 使用新的API获取文件路径
          const filePath = window.api.file.getPathForFile(file)

          // 如果没有路径，可能是剪贴板中的图像数据
          if (!filePath) {
            // 图像生成也支持图像编辑
            if (file.type.startsWith('image/') && supportExts.includes(getFileExtension(file.name))) {
              const tempFilePath = await window.api.file.createTempFile(file.name)
              const arrayBuffer = await file.arrayBuffer()
              const uint8Array = new Uint8Array(arrayBuffer)
              await window.api.file.write(tempFilePath, uint8Array)
              const selectedFile = await window.api.file.get(tempFilePath)
              if (selectedFile) {
                setFiles((prevFiles) => [...prevFiles, selectedFile])
                break
              }
            } else {
              if (t) {
                window.toast.info(t('chat.input.file_not_supported'))
              }
            }
            continue
          }

          // 有路径的情况
          if (await isSupportedFile(filePath, extensionSet)) {
            const selectedFile = await window.api.file.get(filePath)
            if (selectedFile) {
              setFiles((prevFiles) => [...prevFiles, selectedFile])
            }
          } else {
            if (t) {
              window.toast.info(t('chat.input.file_not_supported'))
            }
          }
        }
      } catch (error) {
        logger.error('onPaste:', error as Error)
        if (t) {
          window.toast.error(t('chat.input.file_error'))
        }
      }
      return true
    }
    // 其他情况默认粘贴
    return false
  } catch (error) {
    logger.error('handlePaste error:', error as Error)
    return false
  }
}

/**
 * 设置最后聚焦的组件
 */
export const setLastFocusedComponent = (component: ComponentType) => {
  lastFocusedComponent = component
}

/**
 * 获取最后聚焦的组件
 */
export const getLastFocusedComponent = (): ComponentType => {
  return lastFocusedComponent
}

/**
 * 注册组件的粘贴处理函数
 *
 * r2-58：原先还有一个 `init()` 在 document 上挂全局 `paste` 监听并路由到这里的 handler。
 * 那条路径**不可达**：唯一的初始化点是 inputbar，而 inputbar 的活跃元素恒为 textarea，
 * `handleGlobalPaste` 开头的守卫（INPUT/TEXTAREA/contenteditable ⇒ 直接 return false）
 * 让路由与兜底分支永远拿不到事件；真正的粘贴入口是各组件自己的 `onPaste`
 *（`InputbarCore.tsx:577`、`MessageEditor.tsx`）。故删除 `init`/`handleGlobalPaste`/`isInitialized`，
 * 只保留注册表本身。
 */
export const registerHandler = (component: ComponentType, handler: PasteHandler) => {
  if (!component) return

  // Only log and update if the handler actually changes
  if (!handlers[component] || handlers[component] !== handler) {
    handlers[component] = handler
  }
}

/**
 * 移除组件的粘贴处理函数
 */
export const unregisterHandler = (component: ComponentType) => {
  if (!component || !handlers[component]) return

  delete handlers[component]
}

export default {
  handlePaste,
  setLastFocusedComponent,
  getLastFocusedComponent,
  registerHandler,
  unregisterHandler
}
