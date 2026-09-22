/**
 * 知识库向量存储（批次4）：每库一个 LibSQL 单文件库（{userData}/Data/KnowledgeBase/<sanitize(id)>/vec.db）。
 *
 * fork 裁剪：不移植 embedjs 全家（@cherrystudio/embedjs + embedjs-libsql），用
 * @libsql/client 自建最小向量表；检索 = 全表扫描 + JS 余弦相似度（个人规模诚实
 * 可行，无 ANN 索引——库上万 chunk 时检索是 O(n) 全量内存比较，见交付注记）。
 * 上游 LibSqlDb 语义对齐点：每 chunk 存 uniqueId（条目级标识，删除/重试按它删）、
 * metadata（source 等来源信息随结果回渲染层）。
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'

const logger = loggerService.withContext('KnowledgeVectorStore')

export interface VectorChunkRow {
  /** 条目级标识（KnowledgeItem.uniqueId）——删除/重试按它整批删。 */
  uniqueId: string
  content: string
  metadata: Record<string, unknown>
  /** 归一化后的嵌入向量（浮点数组，存 JSON 文本）。 */
  vector: number[]
}

/** LibSQL 文件路径 sanitize（防路径穿越；上游 KnowledgeService 同语义）。 */
export function sanitizeBaseId(baseId: string): string {
  return baseId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 余弦相似度（向量必须先归一化；零向量返回 0）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface SearchHit {
  pageContent: string
  score: number
  metadata: Record<string, unknown>
  uniqueId: string
}

export class BaseVectorStore {
  private readonly client: Client

  private constructor(client: Client) {
    this.client = client
  }

  /** 打开（不存在则建）一个库文件 + 表结构。 */
  static async open(baseId: string, dataDir: string): Promise<BaseVectorStore> {
    const dbPath = join(dataDir, sanitizeBaseId(baseId), 'vec.db')
    await mkdir(dirname(dbPath), { recursive: true })
    const client = createClient({ url: `file:${dbPath}` })
    await client.execute(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unique_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        vector TEXT NOT NULL
      )
    `)
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_chunks_unique_id ON chunks(unique_id)`)
    logger.info(`knowledge: opened vector store for base "${baseId}" at ${dbPath}`)
    return new BaseVectorStore(client)
  }

  async insert(rows: VectorChunkRow[]): Promise<void> {
    if (rows.length === 0) return
    const stmts = rows.map((row) => ({
      sql: 'INSERT INTO chunks (unique_id, content, metadata, vector) VALUES (?, ?, ?, ?)',
      args: [row.uniqueId, row.content, JSON.stringify(row.metadata), JSON.stringify(row.vector)]
    }))
    await this.client.batch(stmts, 'write')
  }

  async deleteByUniqueId(uniqueId: string): Promise<void> {
    await this.client.execute({ sql: 'DELETE FROM chunks WHERE unique_id = ?', args: [uniqueId] })
  }

  async deleteByUniqueIds(uniqueIds: string[]): Promise<void> {
    for (const uniqueId of uniqueIds) {
      await this.deleteByUniqueId(uniqueId)
    }
  }

  /** 全表余弦检索（topK 由调用方裁；返回按分数降序）。 */
  async search(queryVector: number[], topK: number): Promise<SearchHit[]> {
    const result = await this.client.execute('SELECT unique_id, content, metadata, vector FROM chunks')
    const hits: SearchHit[] = []
    for (const row of result.rows) {
      const vector = JSON.parse(String(row.vector)) as number[]
      hits.push({
        uniqueId: String(row.unique_id),
        pageContent: String(row.content),
        metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
        score: cosineSimilarity(queryVector, vector)
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, Math.max(1, topK))
  }

  async count(): Promise<number> {
    const result = await this.client.execute('SELECT COUNT(*) AS n FROM chunks')
    return Number(result.rows[0]?.n ?? 0)
  }

  async close(): Promise<void> {
    this.client.close()
  }

  /** 硬删库文件由调用方负责（关闭句柄后删目录）。 */
  static dbDir(dataDir: string, baseId: string): string {
    return join(dataDir, sanitizeBaseId(baseId))
  }
}
