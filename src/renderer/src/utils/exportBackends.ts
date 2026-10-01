/**
 * 外部导出后端（拆分）。
 *
 * `utils/export.ts` 是首屏静态面（`MessageMenubar.tsx` / `Topics.tsx` / `MessagesService.ts`
 * 顶层 import 纯文本能力），此前它顶层 import `@notionhq/client` + `@tryfabric/martian` +
 * `notion-helper`（约 1.73MB 源体积，构建后整包进首屏 store chunk），并把 `utils/image`
 * （`html-to-image` + `browser-image-compression`）一并拖进首屏静态图。
 *
 * 本模块承载"点了导出才发生"的后端闭包。**只被 `utils/export.ts` 内 `await import()` 消费**，
 * 因此 rollup 把它及其 weight 闭包切成懒 chunk（实测首屏 −0.72MB）。
 * 任何从首屏静态面 import 本文件的行为都会让收益消失。
 */
import { loggerService } from '@logger'
import { Client } from '@notionhq/client'
import i18n from '@renderer/i18n'
import store from '@renderer/store'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { removeSpecialCharactersForFileName } from '@renderer/utils/file'
import { getThinkingContent } from '@renderer/utils/messageUtils/find'
import { markdownToBlocks } from '@tryfabric/martian'
import { appendBlocks } from 'notion-helper'

import type { ExportStateAccess } from './export'
import { messageToMarkdown, messageToMarkdownWithReasoning } from './export'

const logger = loggerService.withContext('Utils:exportBackends')

/** 导出中状态的读写口（由 `utils/export.ts` 注入：backend 与 lite 共享同一 Redux 标志）。 */
let exportState: ExportStateAccess | null = null
export function configureExportBackends(access: ExportStateAccess): void {
  exportState = access
}

const getExportState = (): boolean => exportState?.get() ?? false
const setExportingState = (isExporting: boolean): void => exportState?.set(isExporting)

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

const messagesToMarkdown = (messages: Message[], exportReasoning?: boolean, excludeCitations?: boolean): string => {
  return messages
    .map((message) =>
      exportReasoning
        ? messageToMarkdownWithReasoning(message, excludeCitations)
        : messageToMarkdown(message, excludeCitations)
    )
    .join('\n---\n')
}

const convertMarkdownToNotionBlocks = async (markdown: string): Promise<any[]> => {
  return markdownToBlocks(markdown)
}

const convertThinkingToNotionBlocks = async (thinkingContent: string): Promise<any[]> => {
  if (!thinkingContent.trim()) {
    return []
  }

  try {
    // 预处理思维链内容：将HTML的<br>标签转换为真正的换行符
    const processedContent = thinkingContent.replace(/<br\s*\/?>/g, '\n')

    // 使用 markdownToBlocks 处理思维链内容
    const childrenBlocks = markdownToBlocks(processedContent)

    return [
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: '🤔 ' + i18n.t('common.reasoning_content')
              },
              annotations: {
                bold: true
              }
            }
          ],
          children: childrenBlocks
        }
      }
    ]
  } catch (error) {
    logger.error('failed to process reasoning content:', error as Error)
    // 发生错误时，回退到简单的段落处理
    return [
      {
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: '🤔 ' + i18n.t('common.reasoning_content')
              },
              annotations: {
                bold: true
              }
            }
          ],
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    text: {
                      content:
                        thinkingContent.length > 1800
                          ? thinkingContent.substring(0, 1800) + '...\n' + i18n.t('export.notion.reasoning_truncated')
                          : thinkingContent
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}

const executeNotionExport = async (title: string, allBlocks: any[]): Promise<boolean> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return false
  }

  const { notionDatabaseID, notionApiKey } = store.getState().settings
  if (!notionApiKey || !notionDatabaseID) {
    window.toast.error(i18n.t('message.error.notion.no_api_key'))
    return false
  }

  if (allBlocks.length === 0) {
    window.toast.error(i18n.t('message.error.notion.export'))
    return false
  }

  setExportingState(true)

  // 限制标题长度
  if (title.length > 32) {
    title = title.slice(0, 29) + '...'
  }

  try {
    const notion = new Client({ auth: notionApiKey })

    const responsePromise = notion.pages.create({
      parent: { database_id: notionDatabaseID },
      properties: {
        [store.getState().settings.notionPageNameKey || 'Name']: {
          title: [{ text: { content: title } }]
        }
      }
    })
    // oxlint 看不到「promise 交给 antd toast.loading」这一消费方式；显式 `void` 表明有意不 await
    //（该 promise 由 toast 与紧随其后的 await 共同消费）。
    void window.toast.loading({ title: i18n.t('message.loading.notion.preparing'), promise: responsePromise })
    const response = await responsePromise

    const exportPromise = appendBlocks({
      block_id: response.id,
      children: allBlocks,
      client: notion
    })
    void window.toast.loading({ title: i18n.t('message.loading.notion.exporting_progress'), promise: exportPromise })

    window.toast.success(i18n.t('message.success.notion.export'))
    return true
  } catch (error: any) {
    // 清理可能存在的loading消息

    logger.error('Notion export failed:', error)
    window.toast.error(i18n.t('message.error.notion.export'))
    return false
  } finally {
    setExportingState(false)
  }
}

export const exportMessageToNotion = async (title: string, content: string, message?: Message): Promise<boolean> => {
  const { notionExportReasoning } = store.getState().settings

  const notionBlocks = await convertMarkdownToNotionBlocks(content)

  if (notionExportReasoning && message) {
    const thinkingContent = getThinkingContent(message)
    if (thinkingContent) {
      const thinkingBlocks = await convertThinkingToNotionBlocks(thinkingContent)
      if (notionBlocks.length > 0) {
        notionBlocks.splice(1, 0, ...thinkingBlocks)
      } else {
        notionBlocks.push(...thinkingBlocks)
      }
    }
  }

  return executeNotionExport(title, notionBlocks)
}

export const exportTopicToNotion = async (topic: Topic): Promise<boolean> => {
  const { notionExportReasoning, excludeCitationsInExport } = store.getState().settings

  const topicMessages = await fetchTopicMessages(topic.id)

  // 创建话题标题块
  const titleBlocks = await convertMarkdownToNotionBlocks(`# ${topic.name}`)

  // 为每个消息创建blocks
  const allBlocks: any[] = [...titleBlocks]

  for (const message of topicMessages) {
    // 将单个消息转换为markdown
    const messageMarkdown = messageToMarkdown(message, excludeCitationsInExport)
    const messageBlocks = await convertMarkdownToNotionBlocks(messageMarkdown)

    if (notionExportReasoning) {
      const thinkingContent = getThinkingContent(message)
      if (thinkingContent) {
        const thinkingBlocks = await convertThinkingToNotionBlocks(thinkingContent)
        if (messageBlocks.length > 0) {
          messageBlocks.splice(1, 0, ...thinkingBlocks)
        } else {
          messageBlocks.push(...thinkingBlocks)
        }
      }
    }

    allBlocks.push(...messageBlocks)
  }

  return executeNotionExport(topic.name, allBlocks)
}

export const exportMarkdownToYuque = async (title: string, content: string): Promise<any | null> => {
  const { yuqueToken, yuqueRepoId } = store.getState().settings

  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  if (!yuqueToken || !yuqueRepoId) {
    window.toast.error(i18n.t('message.error.yuque.no_config'))
    return
  }

  setExportingState(true)

  try {
    const response = await fetch(`https://www.yuque.com/api/v2/repos/${yuqueRepoId}/docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': yuqueToken,
        'User-Agent': 'Re_Cherry'
      },
      body: JSON.stringify({
        title: title,
        slug: Date.now().toString(), // 使用时间戳作为唯一slug
        format: 'markdown',
        body: content
      })
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    const doc_id = data.data.id

    const tocResponse = await fetch(`https://www.yuque.com/api/v2/repos/${yuqueRepoId}/toc`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': yuqueToken,
        'User-Agent': 'Re_Cherry'
      },
      body: JSON.stringify({
        action: 'appendNode',
        action_mode: 'sibling',
        doc_ids: [doc_id]
      })
    })

    if (!tocResponse.ok) {
      throw new Error(`HTTP error! status: ${tocResponse.status}`)
    }

    window.toast.success(i18n.t('message.success.yuque.export'))
    return data
  } catch (error: any) {
    logger.debug(error)
    window.toast.error(i18n.t('message.error.yuque.export'))
    return null
  } finally {
    setExportingState(false)
  }
}

export interface ObsidianExportAttributes {
  title: string
  created?: string
  source?: string
  tags?: string
  processingMethod: string
  folder: string
  vault: string
}

/**
 * 导出Markdown到Obsidian
 *
 * 写文件通道选型：不走 fs 写 IPC。内容先写入剪贴板，再打开
 * `obsidian://new?...&clipboard` deep link，由 Obsidian 本体落盘（V1 原样）。
 * fork 侧 window.open 的 obsidian: 协议已在 WindowService.setWindowOpenHandler
 * 经 isSafeExternalUrl 白名单（security.ts）放行到 shell.openExternal。
 * @param attributes 文档属性
 * @param attributes.title 标题
 * @param attributes.created 创建时间
 * @param attributes.source 来源
 * @param attributes.tags 标签
 * @param attributes.processingMethod 处理方式（'1' 追加 | '2' 前置 | '3' 新建/覆盖）
 * @param attributes.folder 选择的文件夹路径或文件路径
 * @param attributes.vault 选择的Vault名称
 */
export const exportMarkdownToObsidian = async (attributes: ObsidianExportAttributes): Promise<void> => {
  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  setExportingState(true)

  try {
    // 从参数获取Vault名称
    const obsidianVault = attributes.vault
    let obsidianFolder = attributes.folder || ''
    let isMarkdownFile = false

    if (!obsidianVault) {
      window.toast.error(i18n.t('chat.topics.export.obsidian_no_vault_selected'))
      return
    }

    if (!attributes.title) {
      window.toast.error(i18n.t('chat.topics.export.obsidian_title_required'))
      return
    }

    // 检查是否选择了.md文件
    if (obsidianFolder && obsidianFolder.endsWith('.md')) {
      isMarkdownFile = true
    }

    let filePath = ''

    // 如果是.md文件，直接使用该文件路径
    if (isMarkdownFile) {
      filePath = obsidianFolder
    } else {
      // 否则构建路径
      //构建保存路径添加以 / 结尾
      if (obsidianFolder && !obsidianFolder.endsWith('/')) {
        obsidianFolder = obsidianFolder + '/'
      }

      //构建文件名
      const fileName = transformObsidianFileName(attributes.title)
      filePath = obsidianFolder + fileName + '.md'
    }

    let obsidianUrl = `obsidian://new?file=${encodeURIComponent(filePath)}&vault=${encodeURIComponent(obsidianVault)}&clipboard`

    if (attributes.processingMethod === '3') {
      obsidianUrl += '&overwrite=true'
    } else if (attributes.processingMethod === '2') {
      obsidianUrl += '&prepend=true'
    } else if (attributes.processingMethod === '1') {
      obsidianUrl += '&append=true'
    }

    window.open(obsidianUrl)
    window.toast.success(i18n.t('chat.topics.export.obsidian_export_success'))
  } catch (error) {
    logger.error('Failed to export to Obsidian:', error as Error)
    window.toast.error(i18n.t('chat.topics.export.obsidian_export_failed'))
  } finally {
    setExportingState(false)
  }
}

/**
 * 生成Obsidian文件名,源自 Obsidian  Web Clipper 官方实现,修改了一些细节
 * @param fileName
 * @returns
 */
function transformObsidianFileName(fileName: string): string {
  const platform = window.navigator.userAgent
  const isWin = /win/i.test(platform)
  const isMac = /mac/i.test(platform)

  // 删除Obsidian 全平台无效字符
  let sanitized = fileName.replace(/[#|\\^[\]]/g, '')

  if (isWin) {
    // Windows 的清理
    sanitized = sanitized
      .replace(/[<>:"/\\|?*]/g, '') // 移除无效字符
      .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2') // 避免保留名称
      .replace(/[\s.]+$/, '') // 移除结尾的空格和句点
  } else if (isMac) {
    // Mac 的清理
    sanitized = sanitized
      .replace(/[<>:"/\\|?*]/g, '') // 移除无效字符
      .replace(/^\./, '_') // 避免以句点开头
  } else {
    // Linux 或其他系统
    sanitized = sanitized
      .replace(/[<>:"/\\|?*]/g, '') // 移除无效字符
      .replace(/^\./, '_') // 避免以句点开头
  }

  // 所有平台的通用操作
  sanitized = sanitized
    .replace(/^\.+/, '') // 移除开头的句点
    .trim() // 移除前后空格
    .slice(0, 245) // 截断为 245 个字符，留出空间以追加 ' 1.md'

  // 确保文件名不为空
  if (sanitized.length === 0) {
    sanitized = 'Untitled'
  }

  return sanitized
}

export const exportMarkdownToJoplin = async (
  title: string,
  contentOrMessages: string | Message | Message[]
): Promise<any | null> => {
  const { joplinUrl, joplinToken, joplinExportReasoning, excludeCitationsInExport } = store.getState().settings

  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  if (!joplinUrl || !joplinToken) {
    window.toast.error(i18n.t('message.error.joplin.no_config'))
    return
  }

  setExportingState(true)

  let content: string
  if (typeof contentOrMessages === 'string') {
    content = contentOrMessages
  } else if (Array.isArray(contentOrMessages)) {
    content = messagesToMarkdown(contentOrMessages, joplinExportReasoning, excludeCitationsInExport)
  } else {
    // 单条Message
    content = joplinExportReasoning
      ? messageToMarkdownWithReasoning(contentOrMessages, excludeCitationsInExport)
      : messageToMarkdown(contentOrMessages, excludeCitationsInExport)
  }

  try {
    const baseUrl = joplinUrl.endsWith('/') ? joplinUrl : `${joplinUrl}/`
    const response = await fetch(`${baseUrl}notes?token=${joplinToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: title,
        body: content,
        source: 'Re_Cherry'
      })
    })

    if (!response.ok) {
      throw new Error('service not available')
    }

    const data = await response.json()
    if (data?.error) {
      throw new Error('response error')
    }

    window.toast.success(i18n.t('message.success.joplin.export'))
    return data
  } catch (error: any) {
    logger.error('Failed to export to Joplin:', error)
    window.toast.error(i18n.t('message.error.joplin.export'))
    return null
  } finally {
    setExportingState(false)
  }
}

/**
 * 导出Markdown到思源笔记
 * @param title 笔记标题
 * @param content 笔记内容
 */
export const exportMarkdownToSiyuan = async (title: string, content: string): Promise<void> => {
  const { siyuanApiUrl, siyuanToken, siyuanBoxId, siyuanRootPath } = store.getState().settings

  if (getExportState()) {
    window.toast.warning(i18n.t('message.warn.export.exporting'))
    return
  }

  if (!siyuanApiUrl || !siyuanToken || !siyuanBoxId) {
    window.toast.error(i18n.t('message.error.siyuan.no_config'))
    return
  }

  setExportingState(true)

  try {
    // test connection
    const testResponse = await fetch(`${siyuanApiUrl}/api/notebook/lsNotebooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${siyuanToken}`
      }
    })

    if (!testResponse.ok) {
      throw new Error('API请求失败')
    }

    const testData = await testResponse.json()
    if (testData.code !== 0) {
      throw new Error(`${testData.msg || i18n.t('message.error.unknown')}`)
    }

    // 确保根路径以/开头
    const rootPath = siyuanRootPath?.startsWith('/') ? siyuanRootPath : `/${siyuanRootPath || 'CherryStudio'}`
    const renderedRootPath = await renderSprigTemplate(siyuanApiUrl, siyuanToken, rootPath)
    // 创建文档
    const docTitle = `${title.replace(/[#|\\^\\[\]]/g, '')}`
    const docPath = `${renderedRootPath}/${docTitle}`

    // 创建文档
    await createSiyuanDoc(siyuanApiUrl, siyuanToken, siyuanBoxId, docPath, content)

    window.toast.success(i18n.t('message.success.siyuan.export'))
  } catch (error) {
    logger.error('Failed to export to Siyuan:', error as Error)
    window.toast.error(i18n.t('message.error.siyuan.export') + (error instanceof Error ? `: ${error.message}` : ''))
  } finally {
    setExportingState(false)
  }
}
/**
 * 渲染 思源笔记 Sprig 模板字符串
 * @param apiUrl 思源 API 地址
 * @param token 思源 API Token
 * @param template Sprig 模板
 * @returns 渲染后的字符串
 */
async function renderSprigTemplate(apiUrl: string, token: string, template: string): Promise<string> {
  const response = await fetch(`${apiUrl}/api/template/renderSprig`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`
    },
    body: JSON.stringify({ template })
  })

  const data = await response.json()
  if (data.code !== 0) {
    throw new Error(`${data.msg || i18n.t('message.error.unknown')}`)
  }

  return data.data
}

/**
 * 创建思源笔记文档
 */
async function createSiyuanDoc(
  apiUrl: string,
  token: string,
  boxId: string,
  path: string,
  markdown: string
): Promise<string> {
  const response = await fetch(`${apiUrl}/api/filetree/createDocWithMd`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`
    },
    body: JSON.stringify({
      notebook: boxId,
      path: path,
      markdown: markdown
    })
  })

  const data = await response.json()
  if (data.code !== 0) {
    throw new Error(`${data.msg || i18n.t('message.error.unknown')}`)
  }

  return data.data
}

/**
 * 笔记导出：Markdown / Word / 图片（截图导出闭包只在点导出时才需要）
 */
const exportNoteAsMarkdown = async (noteName: string, content: string): Promise<void> => {
  const markdown = `# ${noteName}\n\n${content}`
  const fileName = removeSpecialCharactersForFileName(noteName) + '.md'
  const result = await window.api.file.save(fileName, markdown)
  if (result) {
    window.toast.success(i18n.t('message.success.markdown.export.specified'))
  }
}

const getScrollableElement = (): HTMLElement | null => {
  const notesPage = document.querySelector('#notes-page')
  if (!notesPage) return null

  const allDivs = notesPage.querySelectorAll('div')
  for (const div of Array.from(allDivs)) {
    const style = window.getComputedStyle(div)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      if (div.querySelector('.ProseMirror')) {
        return div as HTMLElement
      }
    }
  }
  return null
}

const getScrollableRef = (): { current: HTMLElement } | null => {
  const element = getScrollableElement()
  if (!element) {
    window.toast.warning(i18n.t('notes.no_content_to_copy'))
    return null
  }
  return { current: element }
}

const exportNoteAsImageToClipboard = async (): Promise<void> => {
  const scrollableRef = getScrollableRef()
  if (!scrollableRef) return

  // 截图导出闭包（html-to-image + UPNG）按需拉起：此前经 utils/export.ts 静态进首屏
  const { captureScrollableAsBlob } = await import('@renderer/utils/image')
  await captureScrollableAsBlob(scrollableRef, async (blob) => {
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      window.toast.success(i18n.t('common.copied'))
    }
  })
}

const exportNoteAsImageFile = async (noteName: string): Promise<void> => {
  const scrollableRef = getScrollableRef()
  if (!scrollableRef) return

  const { captureScrollableAsDataURL } = await import('@renderer/utils/image')
  const dataUrl = await captureScrollableAsDataURL(scrollableRef)
  if (dataUrl) {
    const fileName = removeSpecialCharactersForFileName(noteName)
    await window.api.file.saveImage(fileName, dataUrl)
  }
}

export interface NoteExportBackendOptions {
  node: { name: string; externalPath: string }
  platform: 'markdown' | 'docx' | 'notion' | 'yuque' | 'obsidian' | 'joplin' | 'siyuan' | 'copyImage' | 'exportImage'
}

/** 笔记导出后端分派（`exportNote` 的懒侧；obsidian 分支同时拉起弹窗 chunk）。 */
export const exportNoteBackend = async ({ node, platform }: NoteExportBackendOptions): Promise<void> => {
  const content = await window.api.file.readExternal(node.externalPath)

  switch (platform) {
    case 'copyImage':
      return await exportNoteAsImageToClipboard()
    case 'exportImage':
      return await exportNoteAsImageFile(node.name)
    case 'markdown':
      return await exportNoteAsMarkdown(node.name, content)
    case 'docx':
      void window.api.export.toWord(`# ${node.name}\n\n${content}`, removeSpecialCharactersForFileName(node.name))
      return
    case 'notion':
      await exportMessageToNotion(node.name, content)
      return
    case 'yuque':
      await exportMarkdownToYuque(node.name, `# ${node.name}\n\n${content}`)
      return
    case 'obsidian': {
      const { default: ObsidianExportPopup } = await import('@renderer/components/Popups/ObsidianExportPopup')
      await ObsidianExportPopup.show({ title: node.name, processingMethod: '1', rawContent: content })
      return
    }
    case 'joplin':
      await exportMarkdownToJoplin(node.name, content)
      return
    case 'siyuan':
      await exportMarkdownToSiyuan(node.name, `# ${node.name}\n\n${content}`)
      return
  }
}
