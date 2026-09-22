/**
 * 引用标记 → 渲染标签管线（V2 cherry-studio utils/citation.ts 迁移件；
 * 生产链为 fork 的 kernelChat 投影——见 MainTextBlock）。
 *
 * V2 加固点（相对 v1.9.11）：
 * - data-citation 属性只存编号，引用数据走 out-of-band registry（React context）
 *   ——不再把 JSON 序列化进 HTML 属性（安全加固）。
 * - 无 URL 的引用（知识库/记忆）输出裸 <sup>，由 Markdown 的 sup 组件
 *   （CitationSup）挂弹层；v1 的空括号链接形态会被 rehype-harden 拆掉。
 * - isLinkableCitationUrl 是 generateCitationTag / Link / CitationSup 三处
 *   共用的同一判定。
 */
import type { GroundingSupport } from '@google/genai'
import type { Citation, WebSearchSource } from '@renderer/types'
import { WEB_SEARCH_SOURCE } from '@renderer/types'
import removeMarkdown from 'remove-markdown'

/** 是否可作外链打开（知识库/记忆引用 url 为空）。 */
export function isLinkableCitationUrl(url?: string): boolean {
  return !!url && url.startsWith('http')
}

/**
 * 从多个 citationReference 中获取第一个有效的 source
 * @returns WebSearchSource
 */
export function determineCitationSource(
  citationReferences: Array<{ citationBlockId?: string; citationBlockSource?: WebSearchSource }> | undefined
): WebSearchSource | undefined {
  // 从 citationReferences 获取第一个有效的 source
  if (citationReferences?.length) {
    const validReference = citationReferences.find((ref) => ref.citationBlockSource)
    return validReference?.citationBlockSource
  }

  return undefined
}

/** 知识库来源展示名：取路径末段（兼容 \ 与 /）。模型侧保留全路径，仅展示层收窄。 */
function knowledgeBasename(source?: string): string | undefined {
  if (!source) return undefined
  return source.split(/[\\/]/).pop() || source
}

/**
 * 悬浮胶囊所用的安全形态：
 * - remove-markdown 剥结构符号（标题#/引用>/围栏/加粗）但保留代码内容——此前用
 *   cleanMarkdownContent 连 `<string.h>` 的尖括号、点号一起剥，代码类知识库的
 *   摘录被打成乱码（真机反馈）；摘录截 200 字符（V2 同语义）
 * - 知识库标题取路径末段（Windows 反斜杠路径此前显示整条）
 */
export function toTooltipCitation(citation: Citation): Citation {
  return {
    ...citation,
    title: (citation.type === 'knowledge' ? knowledgeBasename(citation.title) : citation.title?.trim()) || undefined,
    content: removeMarkdown(citation.content ?? '').slice(0, 200) || undefined
  }
}

/**
 * 把文本内容中的引用标记转换为完整的引用标签
 * - 标准化引用标记
 * - 转换标记为用于渲染的标签
 *
 * @param content 原始文本内容
 * @param citations 原始引用列表
 * @param sourceType 引用来源类型
 * @returns 处理后的文本内容
 */
export function withCitationTags(content: string, citations: Citation[], sourceType?: WebSearchSource): string {
  if (!content || citations.length === 0) return content

  const cleaned = citations.map(toTooltipCitation)
  const citationMap = new Map(cleaned.map((c) => [c.number, c]))

  const normalizedContent = normalizeCitationMarks(content, citationMap, sourceType)

  return mapCitationMarksToTags(normalizedContent, new Map(cleaned.map((c) => [c.number, c])))
}

/**
 * 标准化引用标记，统一转换为 [cite:N] 格式：
 * - OpenAI 格式: [<sup>N</sup>](url) → [cite:N]
 * - Gemini 格式: 根据metadata添加 [cite:N]
 * - 其他格式: [N] → [cite:N]
 *
 * 算法：
 * - one pass + 正则替换
 * - 跳过代码块等特殊上下文
 *
 * @param content 原始文本内容
 * @param citationMap 引用映射表
 * @param sourceType 引用来源类型
 * @returns 标准化后的文本内容
 */
export function normalizeCitationMarks(
  content: string,
  citationMap: Map<number, Citation>,
  sourceType?: WebSearchSource
): string {
  // 识别需要跳过的代码区域，注意：indented code block已被禁用，不需要跳过
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]*`/gm
  const skipRanges: Array<{ start: number; end: number }> = []

  let match
  while ((match = codeBlockRegex.exec(content)) !== null) {
    skipRanges.push({
      start: match.index,
      end: match.index + match[0].length
    })
  }

  // 检查位置是否在代码块内
  const shouldSkip = (pos: number): boolean => {
    for (const range of skipRanges) {
      if (pos >= range.start && pos < range.end) return true
      if (range.start > pos) break // 已排序，可以提前结束
    }
    return false
  }

  // 统一的替换函数
  const applyReplacements = (regex: RegExp, getReplacementFn: (match: RegExpExecArray) => string | null) => {
    const replacements: Array<{ start: number; end: number; replacement: string }> = []

    regex.lastIndex = 0 // 重置正则状态
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      if (!shouldSkip(match.index)) {
        const replacement = getReplacementFn(match)
        if (replacement !== null) {
          replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            replacement
          })
        }
      }
    }

    // 从后往前替换避免位置偏移
    replacements.reverse().forEach(({ start, end, replacement }) => {
      content = content.slice(0, start) + replacement + content.slice(end)
    })
  }

  switch (sourceType) {
    case WEB_SEARCH_SOURCE.OPENAI:
    case WEB_SEARCH_SOURCE.OPENAI_RESPONSE:
    case WEB_SEARCH_SOURCE.PERPLEXITY: {
      // OpenAI 格式: [<sup>N</sup>](url) → [cite:N]
      applyReplacements(/\[<sup>(\d+)<\/sup>\]\([^)]*\)/g, (match) => {
        const citationNum = parseInt(match[1], 10)
        return citationMap.has(citationNum) ? `[cite:${citationNum}]` : null
      })
      break
    }
    case WEB_SEARCH_SOURCE.GEMINI: {
      // Gemini 格式: 根据 startIndex/endIndex 精确插入 [cite:N]
      // 注意: Gemini API 的 endIndex 是 UTF-8 字节偏移，需要转换为字符偏移
      const firstCitation = Array.from(citationMap.values())[0]
      if (firstCitation?.metadata) {
        const encoder = new TextEncoder()
        const contentBytes = encoder.encode(content)

        // 将 UTF-8 字节偏移转换为 JS 字符偏移
        const byteOffsetToCharOffset = (byteOffset: number): number => {
          const decoder = new TextDecoder()
          return decoder.decode(contentBytes.slice(0, byteOffset)).length
        }

        // 收集所有需要插入的位置和标签
        const insertions: Array<{ position: number; tag: string }> = []

        firstCitation.metadata.forEach((support: GroundingSupport) => {
          if (!support.groundingChunkIndices || !support.segment) return
          const { endIndex } = support.segment
          if (endIndex == null) return

          const tag = support.groundingChunkIndices
            .map((citationNum) => {
              const citation = citationMap.get(citationNum + 1)
              return citation ? `[cite:${citationNum + 1}]` : ''
            })
            .filter(Boolean)
            .join('')

          if (tag) {
            const charPos = byteOffsetToCharOffset(endIndex)
            insertions.push({ position: charPos, tag })
          }
        })

        // 按位置降序排列，从后往前插入避免偏移
        insertions.sort((a, b) => b.position - a.position)

        for (const { position, tag } of insertions) {
          if (!shouldSkip(position)) {
            content = content.slice(0, position) + tag + content.slice(position)
          }
        }
      }
      break
    }
    case WEB_SEARCH_SOURCE.GROK: {
      // Grok 格式: [[N]](url) → [cite:N]
      applyReplacements(/\[\[(\d+)\]\]\([^)]*\)/g, (match) => {
        const citationNum = parseInt(match[1], 10)
        return citationMap.has(citationNum) ? `[cite:${citationNum}]` : null
      })
      break
    }
    default: {
      // 简单数字格式: [N] → [cite:N]
      applyReplacements(/\[(\d+)\]/g, (match) => {
        const citationNum = parseInt(match[1], 10)
        return citationMap.has(citationNum) ? `[cite:${citationNum}]` : null
      })
    }
  }

  return content
}

/**
 * 把文本内容中的 [cite:N] 标记转换为用于渲染的标签
 * @param content 原始文本内容
 * @param citationMap 引用映射表
 * @returns 处理后的文本内容
 */
export function mapCitationMarksToTags(content: string, citationMap: Map<number, Citation>): string {
  // 统一替换所有 [cite:N] 标记
  return content.replace(/\[cite:(\d+)\]/g, (match, num) => {
    const citationNum = parseInt(num, 10)
    const citation = citationMap.get(citationNum)

    if (citation) {
      return generateCitationTag(citation)
    }

    // 如果没找到对应的引用数据，保持原样（应该不会发生）
    return match
  })
}

/**
 * 生成单个用于渲染的引用标签（V2 形态）
 * @param citation 引用数据
 * @returns 渲染后的引用标签
 *
 * - 有 URL：[<sup data-citation='N'>N</sup>](url) —— Link 组件挂悬浮胶囊
 * - 无 URL（知识库/记忆）：裸 <sup data-citation='N'>N</sup> —— CitationSup 挂胶囊
 */
export function generateCitationTag(citation: Citation): string {
  const supTag = `<sup data-citation='${citation.number}'>${citation.number}</sup>`
  if (!isLinkableCitationUrl(citation.url)) {
    // 知识库/记忆引用无 URL。v1 用空括号 [sup]() 包裹，rehype-harden 会把它
    // 拆成 <span>…<sup/></span>，弹层（只挂 <a> 上）随之丢失。V2 改为输出
    // 裸 sup，由 components.sup（CitationSup）挂弹层。
    return supTag
  }
  // Escape | in URL to avoid breaking GFM table cell parsing
  const safeUrl = citation.url.replace(/\|/g, '%7C')
  return `[${supTag}](${safeUrl})`
}
