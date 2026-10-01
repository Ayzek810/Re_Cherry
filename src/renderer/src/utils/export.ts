import { loggerService } from '@logger'
import i18n from '@renderer/i18n'
import { getProviderLabel } from '@renderer/i18n/label'
import { getMessageTitle } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { setExportState } from '@renderer/store/runtime'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { removeSpecialCharactersForFileName } from '@renderer/utils/file'
import { convertMathFormula, markdownToPlainText } from '@renderer/utils/markdown'
import { getCitationContent, getMainTextContent, getThinkingContent } from '@renderer/utils/messageUtils/find'
import dayjs from 'dayjs'
import DOMPurify from 'dompurify'

import type * as exportBackendsModule from './exportBackends'
import type { NoteExportBackendOptions, ObsidianExportAttributes } from './exportBackends'

export type { ObsidianExportAttributes }

const logger = loggerService.withContext('Utils:export')

// 全局的导出状态获取函数
const getExportState = () => store.getState().runtime.export.isExporting

// 全局的导出状态设置函数，使用 dispatch 保障 Redux 状态更新正确
const setExportingState = (isExporting: boolean) => {
  store.dispatch(setExportState({ isExporting }))
}

/**
 * 导出后端（Notion / 语雀 / Obsidian / Joplin / 思源 / 笔记截图）的懒加载口。
 *
 * v1 二轮性能审计 p2-03/p2-04/p2-07：这些后端的闭包（`@notionhq/client` +
 * `@tryfabric/martian` + `notion-helper` + `dompurify` + `utils/image` 的
 * `html-to-image`/`UPNG`/`browser-image-compression`）此前经本文件的顶层 import
 * 整包进首屏 store chunk。改为函数内 `await import()` 后 rollup 将其切成懒 chunk
 * （实测首屏 −0.318MB，见 `reports/audit2-fixes/performance.md`）。
 *
 * 上面的 `import * as exportBackendsModule` 只用于取**类型**（`typeof exportBackendsModule`），
 * 不产生运行时边——所有值访问都走 `loadExportBackends()` 的动态 import。
 * 加载结果模块级缓存：多次导出只付一次解析成本。
 */
export interface ExportStateAccess {
  get: () => boolean
  set: (isExporting: boolean) => void
}

let backendsPromise: Promise<typeof exportBackendsModule> | null = null
async function loadExportBackends(): Promise<typeof exportBackendsModule> {
  backendsPromise ??= import('./exportBackends').then((module) => {
    // 后端与本文件共享同一个"导出中"Redux 标志（两处各自读 store 会分叉）
    module.configureExportBackends({ get: getExportState, set: setExportingState })
    return module
  })
  return backendsPromise
}

/**
 * 安全地处理思维链内容，保留安全的 HTML 标签如 <br>，移除危险内容
 *
 * 支持的标签：
 * - 结构：br, p, div, span, h1-h6, blockquote
 * - 格式：strong, b, em, i, u, s, del, mark, small, sup, sub
 * - 列表：ul, ol, li
 * - 代码：code, pre, kbd, var, samp
 * - 表格：table, thead, tbody, tfoot, tr, td, th
 *
 * @param content 原始思维链内容
 * @returns 安全处理后的内容
 */
const sanitizeReasoningContent = (content: string): string => {
  // 先处理换行符转换为 <br>
  const contentWithBr = content.replace(/\n/g, '<br>')

  // 使用 DOMPurify 清理内容，保留常用的安全标签和属性
  return DOMPurify.sanitize(contentWithBr, {
    ALLOWED_TAGS: [
      // 换行和基础结构
      'br',
      'p',
      'div',
      'span',
      // 文本格式化
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'del',
      'mark',
      'small',
      // 上标下标（数学公式、引用等）
      'sup',
      'sub',
      // 标题
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      // 引用
      'blockquote',
      // 列表
      'ul',
      'ol',
      'li',
      // 代码相关
      'code',
      'pre',
      'kbd',
      'var',
      'samp',
      // 表格（AI输出中可能包含表格）
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      // 分隔线
      'hr'
    ],
    ALLOWED_ATTR: [
      // 安全的通用属性
      'class',
      'title',
      'lang',
      'dir',
      // code 标签的语言属性
      'data-language',
      // 表格属性
      'colspan',
      'rowspan',
      // 列表属性
      'start',
      'type'
    ],
    KEEP_CONTENT: true, // 保留被移除标签的文本内容
    RETURN_DOM: false,
    SANITIZE_DOM: true,
    // 允许的协议（预留，虽然目前没有允许链接标签）
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i
  })
}

/**
 * 获取话题的消息列表，使用TopicManager确保消息被正确加载
 * 这样可以避免从未打开过的话题导出为空的问题
 * @param topicId 话题ID
 * @returns 话题消息列表
 */
async function fetchTopicMessages(topicId: string): Promise<Message[]> {
  const { TopicManager } = await import('@renderer/hooks/useTopic')
  return await TopicManager.getTopicMessages(topicId)
}

/**
 * 从消息内容中提取标题，限制长度并处理换行和标点符号。用于导出功能。
 * @param {string} str 输入字符串
 * @param {number} [length=80] 标题最大长度，默认为 80
 * @returns {string} 提取的标题
 */
export function getTitleFromString(str: string, length: number = 80): string {
  let title = str.trimStart().split('\n')[0]

  if (title.includes('。')) {
    title = title.split('。')[0]
  } else if (title.includes('，')) {
    title = title.split('，')[0]
  } else if (title.includes('.')) {
    title = title.split('.')[0]
  } else if (title.includes(',')) {
    title = title.split(',')[0]
  }

  if (title.length > length) {
    title = title.slice(0, length)
  }

  if (!title) {
    title = str.slice(0, length)
  }

  return title
}

const getRoleText = (role: string, modelName?: string, providerId?: string): string => {
  const { showModelNameInMarkdown, showModelProviderInMarkdown } = store.getState().settings

  if (role === 'user') {
    return '🧑‍💻 User'
  } else if (role === 'system') {
    return '🤖 System'
  } else {
    let assistantText = '🤖 '
    if (showModelNameInMarkdown && modelName) {
      assistantText += `${modelName}`
      if (showModelProviderInMarkdown && providerId) {
        const providerDisplayName = getProviderLabel(providerId) ?? providerId
        assistantText += ` | ${providerDisplayName}`
        return assistantText
      }
      return assistantText
    } else if (showModelProviderInMarkdown && providerId) {
      const providerDisplayName = getProviderLabel(providerId) ?? providerId
      assistantText += `Assistant | ${providerDisplayName}`
      return assistantText
    }
    return assistantText + 'Assistant'
  }
}

/**
 * 处理文本中的引用标记
 * @param content 原始文本内容
 * @param mode 处理模式：'remove' 移除引用，'normalize' 标准化为Markdown格式
 * @returns 处理后的文本
 */
export const processCitations = (content: string, mode: 'remove' | 'normalize' = 'remove'): string => {
  // 使用正则表达式匹配Markdown代码块
  const codeBlockRegex = /(```[a-zA-Z]*\n[\s\S]*?\n```)/g
  const parts = content.split(codeBlockRegex)

  const processedParts = parts.map((part, index) => {
    // 如果是代码块(奇数索引),则原样返回
    if (index % 2 === 1) {
      return part
    }

    let result = part

    if (mode === 'remove') {
      // 移除各种形式的引用标记
      result = result
        .replace(/\[<sup[^>]*data-citation[^>]*>\d+<\/sup>\]\([^)]*\)/g, '')
        .replace(/\[<sup[^>]*>\d+<\/sup>\]\([^)]*\)/g, '')
        .replace(/<sup[^>]*data-citation[^>]*>\d+<\/sup>/g, '')
        .replace(/\[(\d+)\](?!\()/g, '')
    } else if (mode === 'normalize') {
      // 标准化引用格式为Markdown脚注格式
      result = result
        // 将 [<sup data-citation='...'>数字</sup>](链接) 转换为 [^数字]
        .replace(/\[<sup[^>]*data-citation[^>]*>(\d+)<\/sup>\]\([^)]*\)/g, '[^$1]')
        // 将 [<sup>数字</sup>](链接) 转换为 [^数字]
        .replace(/\[<sup[^>]*>(\d+)<\/sup>\]\([^)]*\)/g, '[^$1]')
        // 将独立的 <sup data-citation='...'>数字</sup> 转换为 [^数字]
        .replace(/<sup[^>]*data-citation[^>]*>(\d+)<\/sup>/g, '[^$1]')
        // 将 [数字] 转换为 [^数字]（但要小心不要转换其他方括号内容）
        .replace(/\[(\d+)\](?!\()/g, '[^$1]')
    }

    // 按行处理，保留Markdown结构
    const lines = result.split('\n')
    const processedLines = lines.map((line) => {
      // 如果是引用块或其他特殊格式，不要修改空格
      if (line.match(/^>|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|^\s{4,}/)) {
        return line.replace(/[ ]+/g, ' ').replace(/[ ]+$/g, '')
      }
      // 普通文本行，清理多余空格但保留基本格式
      return line.replace(/[ ]+/g, ' ').trim()
    })

    return processedLines.join('\n')
  })

  return processedParts.join('').trim()
}

/**
 * 标准化引用内容为Markdown脚注格式
 * @param citations 引用列表
 * @returns Markdown脚注格式的引用内容
 */
const formatCitationsAsFootnotes = (citations: string): string => {
  if (!citations.trim()) return ''

  // 将引用列表转换为脚注格式
  const lines = citations.split('\n\n')
  const footnotes = lines.map((line) => {
    const match = line.match(/^\[(\d+)\]\s*(.+)/)
    if (match) {
      const [, num, content] = match
      return `[^${num}]: ${content}`
    }
    return line
  })

  return footnotes.join('\n\n')
}

const createBaseMarkdown = (
  message: Message,
  includeReasoning: boolean = false,
  excludeCitations: boolean = false,
  normalizeCitations: boolean = true
): { titleSection: string; reasoningSection: string; contentSection: string; citation: string } => {
  const { forceDollarMathInMarkdown } = store.getState().settings
  const roleText = getRoleText(message.role, message.model?.name, message.model?.provider)
  const titleSection = `## ${roleText}`
  let reasoningSection = ''

  if (includeReasoning) {
    let reasoningContent = getThinkingContent(message)
    if (reasoningContent) {
      if (reasoningContent.startsWith('<think>\n')) {
        reasoningContent = reasoningContent.substring(8)
      } else if (reasoningContent.startsWith('<think>')) {
        reasoningContent = reasoningContent.substring(7)
      }
      // 使用 DOMPurify 安全地处理思维链内容
      reasoningContent = sanitizeReasoningContent(reasoningContent)
      if (forceDollarMathInMarkdown) {
        reasoningContent = convertMathFormula(reasoningContent)
      }
      reasoningSection = `<div style="border: 2px solid #dddddd; border-radius: 10px;">
  <details style="padding: 5px;">
    <summary>${i18n.t('common.reasoning_content')}</summary>
    ${reasoningContent}
  </details>
</div>
`
    }
  }

  const content = getMainTextContent(message)
  let citation = excludeCitations ? '' : getCitationContent(message)

  let processedContent = forceDollarMathInMarkdown ? convertMathFormula(content) : content

  // 处理引用标记
  if (excludeCitations) {
    processedContent = processCitations(processedContent, 'remove')
  } else if (normalizeCitations) {
    processedContent = processCitations(processedContent, 'normalize')
    citation = formatCitationsAsFootnotes(citation)
  }

  return { titleSection, reasoningSection, contentSection: processedContent, citation }
}

export const messageToMarkdown = (message: Message, excludeCitations?: boolean): string => {
  const { excludeCitationsInExport, standardizeCitationsInExport } = store.getState().settings
  const shouldExcludeCitations = excludeCitations ?? excludeCitationsInExport
  const { titleSection, contentSection, citation } = createBaseMarkdown(
    message,
    false,
    shouldExcludeCitations,
    standardizeCitationsInExport
  )
  return [titleSection, '', contentSection, citation].join('\n')
}

export const messageToMarkdownWithReasoning = (message: Message, excludeCitations?: boolean): string => {
  const { excludeCitationsInExport, standardizeCitationsInExport } = store.getState().settings
  const shouldExcludeCitations = excludeCitations ?? excludeCitationsInExport
  const { titleSection, reasoningSection, contentSection, citation } = createBaseMarkdown(
    message,
    true,
    shouldExcludeCitations,
    standardizeCitationsInExport
  )
  return [titleSection, '', reasoningSection, contentSection, citation].join('\n')
}

export const messagesToMarkdown = (
  messages: Message[],
  exportReasoning?: boolean,
  excludeCitations?: boolean
): string => {
  return messages
    .map((message) =>
      exportReasoning
        ? messageToMarkdownWithReasoning(message, excludeCitations)
        : messageToMarkdown(message, excludeCitations)
    )
    .join('\n---\n')
}

const formatMessageAsPlainText = (message: Message): string => {
  const roleText = message.role === 'user' ? 'User:' : 'Assistant:'
  const content = getMainTextContent(message)
  const plainTextContent = markdownToPlainText(content).trim()
  return `${roleText}\n${plainTextContent}`
}

export const messageToPlainText = (message: Message): string => {
  const content = getMainTextContent(message)
  return markdownToPlainText(content).trim()
}

const messagesToPlainText = (messages: Message[]): string => {
  return messages.map(formatMessageAsPlainText).join('\n\n')
}

export const topicToMarkdown = async (
  topic: Topic,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<string> => {
  const topicName = `# ${topic.name}`

  const messages = await fetchTopicMessages(topic.id)

  if (messages && messages.length > 0) {
    return topicName + '\n\n' + messagesToMarkdown(messages, exportReasoning, excludeCitations)
  }

  return topicName
}

export const topicToPlainText = async (topic: Topic): Promise<string> => {
  const topicName = markdownToPlainText(topic.name).trim()

  const topicMessages = await fetchTopicMessages(topic.id)

  if (topicMessages && topicMessages.length > 0) {
    return topicName + '\n\n' + messagesToPlainText(topicMessages)
  }

  return topicName
}

export const exportTopicAsMarkdown = async (
  topic: Topic,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<void> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  setExportingState(true)

  const { markdownExportPath } = store.getState().settings
  if (!markdownExportPath) {
    try {
      const fileName = removeSpecialCharactersForFileName(topic.name) + '.md'
      const markdown = await topicToMarkdown(topic, exportReasoning, excludeCitations)
      const result = await window.api.file.save(fileName, markdown)
      if (result) {
        window.toast.success(i18n.t('message.success.markdown.export.specified'))
      }
    } catch (error: any) {
      window.toast.error(i18n.t('message.error.markdown.export.specified'))
      logger.error('Failed to export topic as markdown:', error)
    } finally {
      setExportingState(false)
    }
  } else {
    try {
      const timestamp = dayjs().format('YYYY-MM-DD-HH-mm-ss')
      const fileName = removeSpecialCharactersForFileName(topic.name) + ` ${timestamp}.md`
      const markdown = await topicToMarkdown(topic, exportReasoning, excludeCitations)
      await window.api.file.write(markdownExportPath + '/' + fileName, markdown)
      window.toast.success(i18n.t('message.success.markdown.export.preconf'))
    } catch (error: any) {
      window.toast.error(i18n.t('message.error.markdown.export.preconf'))
      logger.error('Failed to export topic as markdown:', error)
    } finally {
      setExportingState(false)
    }
  }
}

export const exportMessageAsMarkdown = async (
  message: Message,
  exportReasoning?: boolean,
  excludeCitations?: boolean
): Promise<void> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  setExportingState(true)

  const { markdownExportPath } = store.getState().settings
  if (!markdownExportPath) {
    try {
      const title = await getMessageTitle(message)
      const fileName = removeSpecialCharactersForFileName(title) + '.md'
      const markdown = exportReasoning
        ? messageToMarkdownWithReasoning(message, excludeCitations)
        : messageToMarkdown(message, excludeCitations)
      const result = await window.api.file.save(fileName, markdown)
      if (result) {
        window.toast.success(i18n.t('message.success.markdown.export.specified'))
      }
    } catch (error: any) {
      window.toast.error(i18n.t('message.error.markdown.export.specified'))
      logger.error('Failed to export message as markdown:', error)
    } finally {
      setExportingState(false)
    }
  } else {
    try {
      const timestamp = dayjs().format('YYYY-MM-DD-HH-mm-ss')
      const title = await getMessageTitle(message)
      const fileName = removeSpecialCharactersForFileName(title) + ` ${timestamp}.md`
      const markdown = exportReasoning
        ? messageToMarkdownWithReasoning(message, excludeCitations)
        : messageToMarkdown(message, excludeCitations)
      await window.api.file.write(markdownExportPath + '/' + fileName, markdown)
      window.toast.success(i18n.t('message.success.markdown.export.preconf'))
    } catch (error: any) {
      window.toast.error(i18n.t('message.error.markdown.export.preconf'))
      logger.error('Failed to export message as markdown:', error)
    } finally {
      setExportingState(false)
    }
  }
}

// ---------------------------------------------------------------------------
// 外部后端导出入口（v1 二轮性能审计 p2-03/p2-04/p2-07：闭包懒加载）。
// 签名与旧实现逐字一致——调用方（Topics.tsx / MessageMenubar.tsx / ObsidianExportDialog.tsx）
// 只 import 本文件即为纯文本能力；后端闭包只在真正调用时解析。
// ---------------------------------------------------------------------------

export const exportMessageToNotion = async (title: string, content: string, message?: Message): Promise<boolean> => {
  const backends = await loadExportBackends()
  return await backends.exportMessageToNotion(title, content, message)
}

export const exportTopicToNotion = async (topic: Topic): Promise<boolean> => {
  const backends = await loadExportBackends()
  return await backends.exportTopicToNotion(topic)
}

export const exportMarkdownToYuque = async (title: string, content: string): Promise<any | null> => {
  const backends = await loadExportBackends()
  return await backends.exportMarkdownToYuque(title, content)
}

export const exportMarkdownToObsidian = async (attributes: ObsidianExportAttributes): Promise<void> => {
  const backends = await loadExportBackends()
  return await backends.exportMarkdownToObsidian(attributes)
}

export const exportMarkdownToJoplin = async (
  title: string,
  contentOrMessages: string | Message | Message[]
): Promise<any | null> => {
  const backends = await loadExportBackends()
  return await backends.exportMarkdownToJoplin(title, contentOrMessages)
}

export const exportMarkdownToSiyuan = async (title: string, content: string): Promise<void> => {
  const backends = await loadExportBackends()
  return await backends.exportMarkdownToSiyuan(title, content)
}

// ---------------------------------------------------------------------------
// 笔记导出（v0.3.3-2 笔记移植，V1 原样；obsidian 一路随 ObsidianExportDialog/Popup
// 链的移植（v0.4.7）补回——内容经剪贴板 + obsidian:// deep link 交给 Obsidian 本体）
// 后端实现在 utils/exportBackends.ts（懒 chunk），本入口只做分派。
// ---------------------------------------------------------------------------

export interface NoteExportOptions {
  node: { name: string; externalPath: string }
  platform: 'markdown' | 'docx' | 'notion' | 'yuque' | 'obsidian' | 'joplin' | 'siyuan' | 'copyImage' | 'exportImage'
}

export const exportNote = async ({ node, platform }: NoteExportOptions): Promise<void> => {
  try {
    const backends = await loadExportBackends()
    return await backends.exportNoteBackend({ node, platform } satisfies NoteExportBackendOptions)
  } catch (error) {
    logger.error(`Failed to export note to ${platform}:`, error as Error)
    throw error
  }
}
