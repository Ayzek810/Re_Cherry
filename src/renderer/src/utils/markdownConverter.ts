/**
 * v0.3.2 自 CS_V1 移植（精简版；批次1 仅供 knowledge 笔记列表做纯文本预览）。
 * fork 分叉点：上游实现走 markdown-it + turndown + he + striptags（依赖富文本编辑器链路，
 * fork 已随 TipTap 一并移除）。isMarkdownContent 为纯判断、逐字保留；
 * markdownToPreviewText 以正则剥离代替完整 HTML 渲染，仅用于 ≤50 字符的列表预览，
 * 非富文本语义等价——若批次4 需要完整转换，届时随依赖一并恢复。
 */

/**
 * Checks if content is Markdown (contains Markdown syntax)
 * @param content - Content to check
 * @returns True if content appears to be Markdown
 */
export const isMarkdownContent = (content: string): boolean => {
  if (!content) return false

  // Check for common Markdown syntax
  const markdownPatterns = [
    /^#{1,6}\s/, // Headers
    /^\*\s|^-\s|^\+\s/, // Unordered lists
    /^\d+\.\s/, // Ordered lists
    /\*\*.*\*\*/, // Bold
    /\*.*\*/, // Italic
    /`.*`/, // Inline code
    /```/, // Code blocks
    /^>/, // Blockquotes
    /\[.*\]\(.*\)/, // Links
    /!\[.*\]\(.*\)/ // Images
  ]

  return markdownPatterns.some((pattern) => pattern.test(content))
}

/**
 * Gets plain text preview from Markdown content (fork 精简实现，见文件头注释)
 * @param markdown - Markdown string
 * @param maxLength - Maximum length for preview
 * @returns Plain text preview
 */
export const markdownToPreviewText = (markdown: string, maxLength: number = 50): string => {
  if (!markdown) return ''

  const textContent = markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^\s*[-*+]\s+/gm, '') // unordered list markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list markers
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/<[^>]+>/g, '') // inline html tags
    .replace(/\s+/g, ' ')
    .trim()

  return textContent.length > maxLength ? `${textContent.slice(0, maxLength)}...` : textContent
}
