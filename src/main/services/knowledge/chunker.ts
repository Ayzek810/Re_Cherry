/**
 * 知识库分块器（批次4）：fork 自写滑窗实现（不移植 embedjs 的 TextSplitter 全家）。
 *
 * 语义对齐上游：chunkSize/chunkOverlap 以字符计（embedjs 语义），空段落优先切分、
 * 超长段落硬切、块间保留 overlap 尾部。字段来自 KnowledgeBaseParams（渲染层可配）。
 */

export interface TextChunk {
  content: string
}

const DEFAULT_CHUNK_SIZE = 1000
const DEFAULT_CHUNK_OVERLAP = 200

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP
): TextChunk[] {
  const size = Math.max(100, Math.floor(chunkSize))
  const overlap = Math.min(Math.max(0, Math.floor(chunkOverlap)), Math.floor(size / 2))
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return []

  // 先按空行切段落，再贪心并入不超过 size 的块；单段超长硬切（带 overlap 尾部）。
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const chunks: string[] = []
  let current = ''

  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed.length > 0) chunks.push(trimmed)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush()
      for (let start = 0; start < paragraph.length; start += size - overlap) {
        const piece = paragraph.slice(start, start + size)
        chunks.push(piece)
        if (start + size >= paragraph.length) break
      }
      continue
    }
    if (current.length === 0) {
      current = paragraph
    } else if (current.length + 2 + paragraph.length <= size) {
      current += '\n\n' + paragraph
    } else {
      flush()
      current = paragraph
    }
  }
  flush()

  return chunks.map((content) => ({ content }))
}
