import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { formatCitationsFromBlock, messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { FileMetadata } from '@renderer/types'
import type {
  CitationMessageBlock,
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  Message,
  MessageBlock,
  ThinkingMessageBlock,
  TranslationMessageBlock
} from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { isLinkableCitationUrl } from '@renderer/utils/citation'

/** 无标题引用的中性占位（导出/复制路径可见）。 */
const citationTitleFallback = () => i18n.t('export.citation.untitled', { defaultValue: 'Untitled' })

/**
 * 按块类型索引：类型 → 该类型的消息块接口。
 * 新增块类型时在这里补一行，`blocksOfType` 调用点即可获得精确返回类型，
 * 不再需要为每个类型复制一份扫描循环。
 */
type MessageBlockByType = {
  [MessageBlockType.MAIN_TEXT]: MainTextMessageBlock
  [MessageBlockType.THINKING]: ThinkingMessageBlock
  [MessageBlockType.IMAGE]: ImageMessageBlock
  [MessageBlockType.FILE]: FileMessageBlock
  [MessageBlockType.CITATION]: CitationMessageBlock
  [MessageBlockType.TRANSLATION]: TranslationMessageBlock
}

/** 一次遍历得到的按类型分桶结果。 */
type MessageBlocksByType = Map<MessageBlockType, MessageBlock[]>

/**
 * 单次遍历消息的块表，按块类型分桶。
 * find* / get* / filters 共用这一份实现，替代原先每个类型一份的逐字复制循环。
 * @param message - 消息对象；无块时返回空桶。
 * @returns 按 MessageBlockType 分桶的块数组（桶内顺序与 message.blocks 一致）。
 */
export const findBlocksByType = (message: Message): MessageBlocksByType => {
  const buckets: MessageBlocksByType = new Map()
  if (!message || !message.blocks || message.blocks.length === 0) {
    return buckets
  }
  const state = store.getState()
  for (const blockId of message.blocks) {
    const block = messageBlocksSelectors.selectById(state, blockId)
    if (!block) continue
    const bucket = buckets.get(block.type)
    if (bucket) {
      bucket.push(block)
    } else {
      buckets.set(block.type, [block])
    }
  }
  return buckets
}

/** 取单一类型的块（分桶结果的薄封装，保留各 find* 的精确返回类型）。 */
const blocksOfType = <K extends keyof MessageBlockByType>(
  buckets: MessageBlocksByType,
  type: K
): MessageBlockByType[K][] => (buckets.get(type) ?? []) as MessageBlockByType[K][]

export const findAllBlocks = (message: Message): MessageBlock[] => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return []
  }
  const state = store.getState()
  const allBlocks: MessageBlock[] = []
  for (const blockId of message.blocks) {
    const block = messageBlocksSelectors.selectById(state, blockId)
    if (block) {
      allBlocks.push(block)
    }
  }
  return allBlocks
}

/**
 * Finds all MainTextMessageBlocks associated with a given message, in order.
 * @param message - The message object.
 * @returns An array of MainTextMessageBlocks (empty if none found).
 */
export const findMainTextBlocks = (message: Message): MainTextMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.MAIN_TEXT)

/**
 * Finds all ThinkingMessageBlocks associated with a given message.
 * @param message - The message object.
 * @returns An array of ThinkingMessageBlocks (empty if none found).
 */
export const findThinkingBlocks = (message: Message): ThinkingMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.THINKING)

/**
 * Finds all ImageMessageBlocks associated with a given message.
 * @param message - The message object.
 * @returns An array of ImageMessageBlocks (empty if none found).
 */
export const findImageBlocks = (message: Message): ImageMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.IMAGE)

/**
 * Finds all FileMessageBlocks associated with a given message.
 * @param message - The message object.
 * @returns An array of FileMessageBlocks (empty if none found).
 */
export const findFileBlocks = (message: Message): FileMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.FILE)

/**
 * Gets the concatenated content string from all MainTextMessageBlocks of a message, in order.
 * @param message - The message object.
 * @returns The concatenated content string or an empty string if no text blocks are found.
 */
export const getMainTextContent = (message: Message): string => {
  const textBlocks = findMainTextBlocks(message)
  return textBlocks.map((block) => block.content).join('\n\n')
}

/**
 * Gets the concatenated content string from all ThinkingMessageBlocks of a message, in order.
 * @param message
 * @returns The concatenated content string or an empty string if no thinking blocks are found.
 */
export const getThinkingContent = (message: Message): string => {
  const thinkingBlocks = findThinkingBlocks(message)
  return thinkingBlocks.map((block) => block.content).join('\n\n')
}

/**
 * 单条引用的导出/复制形态。
 * - 可外链（http/https）：保持原有 `[N] [title](url)` 形态（`title` 缺省时以 url 代标题，
 *   尾段若为 url 则省略链接文字重复）。
 * - 无 url（知识库/记忆引用，url 为空或非 http，见 `isLinkableCitationUrl`）：输出非链接形态
 *   `[N] title`。绝不能对 url 直接 `.slice()`——空 url 会抛 TypeError 并让整段导出失败。
 * - 标题缺失时给中性占位，不崩溃、不留空。
 */
const formatCitationForExport = (citation: { number: number; url?: string; title?: string }): string => {
  const title = citation.title?.trim()
  const label = title || citationTitleFallback()
  if (!isLinkableCitationUrl(citation.url)) {
    return `[${citation.number}] ${label}`
  }
  // URL 是外部数据，截断防止超长链接撑爆导出文档（原行为保留）。
  const url = citation.url!.slice(0, 1999)
  return `[${citation.number}] [${title || url}](${url})`
}

export const getCitationContent = (message: Message): string => {
  const citationBlocks = findCitationBlocks(message)
  return citationBlocks
    .map((block) => formatCitationsFromBlock(block))
    .flat()
    .map((citation) => formatCitationForExport(citation))
    .join('\n\n')
}

/**
 * Gets the file content from all FileMessageBlocks and ImageMessageBlocks of a message.
 * @param message - The message object.
 * @returns The file content or an empty string if no file blocks are found.
 */
export const getFileContent = (message: Message): FileMetadata[] => {
  // 原先 file/image 各扫一遍块表；这里用同一次分桶遍历取两类。
  const buckets = findBlocksByType(message)
  const files: FileMetadata[] = []
  for (const block of [
    ...blocksOfType(buckets, MessageBlockType.FILE),
    ...blocksOfType(buckets, MessageBlockType.IMAGE)
  ]) {
    if (block.file) {
      files.push(block.file)
    }
  }
  return files
}

/**
 * Finds all CitationBlocks associated with a given message.
 * @param message - The message object.
 * @returns An array of CitationBlocks (empty if none found).
 */
export const findCitationBlocks = (message: Message): CitationMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.CITATION)

/**
 * Finds all TranslationMessageBlocks associated with a given message.（V1 find.ts 移植）
 * @param message - The message object.
 * @returns An array of TranslationMessageBlocks (empty if none found).
 */
export const findTranslationBlocks = (message: Message): TranslationMessageBlock[] =>
  blocksOfType(findBlocksByType(message), MessageBlockType.TRANSLATION)

/**
 * 构造带工具调用结果的消息内容
 * @deprecated
 * @param blocks
 * @returns
 */
export function getContentWithTools(message: Message) {
  const blocks = findAllBlocks(message)
  let constructedContent = ''
  for (const block of blocks) {
    if (block.type === MessageBlockType.MAIN_TEXT || block.type === MessageBlockType.TOOL) {
      if (block.type === MessageBlockType.MAIN_TEXT) {
        constructedContent += block.content
      } else if (block.type === MessageBlockType.TOOL) {
        // 如果是工具调用结果，为其添加文本消息
        let resultString =
          '\n\nAssistant called a tool.\nTool Name:' +
          block.metadata?.rawMcpToolResponse?.tool.name +
          '\nTool call result: \n```json\n'
        try {
          resultString += JSON.stringify(
            {
              params: block.metadata?.rawMcpToolResponse?.arguments,
              response: block.metadata?.rawMcpToolResponse?.response
            },
            null,
            2
          )
        } catch (e) {
          resultString += 'Invalid Result'
        }
        constructedContent += resultString + '\n```\n\n'
      }
    }
  }
  return constructedContent
}

/**
 * Finds the WebSearchMessageBlock associated with a given message.
 * Assumes only one web search block per message.
 * @param message - The message object.
 * @returns The WebSearchMessageBlock or undefined if not found.
 * @deprecated Web search results are now part of CitationMessageBlock.
 */
/* // Removed function
export const findWebSearchBlock = (message: Message): WebSearchMessageBlock | undefined => {
  if (!message || !message.blocks || message.blocks.length === 0) {
    return undefined
  }
  const state = store.getState()
  for (const blockId of message.blocks) {
    const block = messageBlocksSelectors.selectById(state, blockId)
    if (block && block.type === MessageBlockType.WEB_SEARCH) { // Error here too
      return block as WebSearchMessageBlock
    }
  }
  return undefined
}
*/

// You can add more helper functions here to find other block types if needed.
