/**
 * memory 内核 builtin 工具（v0.4.6，V2 memoryTools.ts 同构移植）。
 *
 * 模型可见的持久记忆：每助手一个受控目录（主进程派生，tools/memoryKernelService），
 * 两文件分工——`memory/FACT.md` 持久知识（update 整体覆写，tmp+rename 原子写，内容经
 * cherry:memory 快照节逐轮注入上下文）；`memory/JOURNAL.jsonl` 事件流水（append 追加、
 * search 查询，工具外不可见）。写入纪律在 description 里：半年后仍有价值才进 FACT，
 * 一次性事件走 append。
 *
 * 安全设计照抄 V2：目录/文件必须是真实项（拒绝 symlink/FIFO）、Windows 大小写不敏感
 * 解析、JOURNAL 以 O_APPEND 原子追加（posix 侧 O_NOFOLLOW）。
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import type { MemoryKernelService } from './memoryKernelService'

const logger = loggerService.withContext('MemoryTool')

export const name = 'tool-memory'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools', 'memory']

const FACT_FILE = 'FACT.md'
const JOURNAL_FILE = 'JOURNAL.jsonl'

const DESCRIPTION =
  "Manage your persistent memory for this assistant across conversations. Actions: 'update' overwrites " +
  'memory/FACT.md with durable knowledge, decisions and preferences that should survive across sessions; ' +
  "'append' adds one event line to memory/JOURNAL.jsonl; 'search' queries the journal. Before writing to " +
  'FACT.md ask: will this still matter in 6 months? If not, use append instead.'

function withNoFollow(flags: number): number {
  return process.platform === 'win32' ? flags : flags | fsConstants.O_NOFOLLOW
}

/** Windows 大小写不敏感文件解析（V2 resolveFileCI 同语义；命中项必须为真实文件）。 */
async function resolveFileCI(dir: string, name: string): Promise<string> {
  const exact = path.join(dir, name)
  try {
    const fileStat = await lstat(exact)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`memory file must be a real file: ${exact}`)
    }
    return exact
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    const entries = await readdir(dir)
    const match = entries.find((entry) => entry.toLowerCase() === name.toLowerCase())
    if (!match) return exact
    const matchedPath = path.join(dir, match)
    const matchedStat = await lstat(matchedPath)
    if (!matchedStat.isFile() || matchedStat.isSymbolicLink()) {
      throw new Error(`memory file must be a real file: ${matchedPath}`)
    }
    return matchedPath
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return exact
    throw error
  }
}

async function assertMemoryDirectory(root: string): Promise<string> {
  const dirStat = await lstat(root)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`memory directory must be a real directory: ${root}`)
  }
  return root
}

async function assertRegularFileOrMissing(filePath: string): Promise<void> {
  try {
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`memory file must be a real file: ${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** update：FACT.md 原子覆写（tmp + rename，写前写后目录/文件身份复核）。 */
export async function memoryUpdate(root: string, content: string): Promise<void> {
  if (content.trim().length === 0) {
    throw new Error("memory: 'content' is required for the update action")
  }
  const memoryDir = await assertMemoryDirectory(root)
  const factPath = await resolveFileCI(memoryDir, FACT_FILE)
  await assertRegularFileOrMissing(factPath)
  const tmpPath = path.join(memoryDir, `.${FACT_FILE}.${randomUUID()}.tmp`)
  const handle = await open(tmpPath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.close()
    await assertMemoryDirectory(memoryDir)
    await assertRegularFileOrMissing(factPath)
    await rename(tmpPath, factPath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

interface JournalEntry {
  ts: string
  tags: string[]
  text: string
}

/** append：JOURNAL.jsonl 单行原子追加（O_APPEND|O_CREAT，posix 加 O_NOFOLLOW）。 */
export async function memoryAppend(root: string, text: string, tags: string[]): Promise<string> {
  if (text.trim().length === 0) {
    throw new Error("memory: 'text' is required for the append action")
  }
  const memoryDir = await assertMemoryDirectory(root)
  const journalPath = await resolveFileCI(memoryDir, JOURNAL_FILE)
  await assertRegularFileOrMissing(journalPath)
  const entry: JournalEntry = { ts: new Date().toISOString(), tags, text }
  const handle = await open(
    journalPath,
    withNoFollow(fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY),
    0o600
  )
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error(`memory journal must be a real file: ${journalPath}`)
    await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf-8')
  } finally {
    await handle.close()
  }
  return entry.ts
}

/** search：JOURNAL 大小写不敏感子串 + tag 过滤 + limit（最新优先；损坏行跳过并记日志）。 */
export async function memorySearch(root: string, query: string, tag: string, limit: number): Promise<JournalEntry[]> {
  const journalPath = await resolveFileCI(await assertMemoryDirectory(root), JOURNAL_FILE)
  let fileContent: string
  try {
    const handle = await open(journalPath, withNoFollow(fsConstants.O_RDONLY))
    try {
      const fileStat = await handle.stat()
      if (!fileStat.isFile()) throw new Error(`memory journal must be a real file: ${journalPath}`)
      fileContent = await handle.readFile('utf-8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const queryLower = query.toLowerCase()
  const tagLower = tag.toLowerCase()
  const matches: JournalEntry[] = []
  for (const line of fileContent.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line) as JournalEntry
      if (tag && !(entry.tags ?? []).some((candidate) => candidate.toLowerCase() === tagLower)) continue
      if (query && !entry.text.toLowerCase().includes(queryLower)) continue
      matches.push(entry)
    } catch {
      logger.warn('memory: skipping corrupted journal line', { journalPath })
    }
  }
  return matches.slice(-limit).reverse()
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'memory',
      description: DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['update', 'append', 'search'],
          description:
            "Action to perform: 'update' overwrites FACT.md (durable knowledge only), 'append' adds a journal entry, 'search' queries the journal."
        },
        content: { type: 'string', description: 'Full markdown content for FACT.md (required for update).' },
        text: { type: 'string', description: 'Journal entry text (required for append).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the journal entry (optional, for append).'
        },
        query: { type: 'string', description: 'Search query — case-insensitive substring match (for search).' },
        tag: { type: 'string', description: 'Filter by tag (optional, for search).' },
        limit: { type: 'number', description: 'Max results to return (default 20, for search).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      async execute(args, exec) {
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('memory: no active conversation turn')
        }
        const memoryKernel = (ctx as unknown as { memory?: MemoryKernelService }).memory
        const root = memoryKernel?.getTurnRoot(topicId)
        if (root === undefined) {
          throw new Error('memory: memory is not enabled for this conversation turn')
        }
        const action = String(args.action ?? '')
        switch (action) {
          case 'update': {
            const content = args.content
            if (typeof content !== 'string' || content.length === 0) {
              throw new Error("memory: 'content' is required for the update action")
            }
            await memoryUpdate(root, content)
            logger.info(`memory: FACT.md updated (${content.length} chars)`)
            return { text: 'Memory updated.' }
          }
          case 'append': {
            const text = args.text
            if (typeof text !== 'string' || text.length === 0) {
              throw new Error("memory: 'text' is required for the append action")
            }
            const tags = Array.isArray(args.tags)
              ? args.tags.filter((tag): tag is string => typeof tag === 'string')
              : []
            const ts = await memoryAppend(root, text, tags)
            logger.info(`memory: journal entry appended (${tags.length} tag(s))`)
            return { text: `Journal entry added at ${ts}.` }
          }
          case 'search': {
            const query = typeof args.query === 'string' ? args.query : ''
            const tag = typeof args.tag === 'string' ? args.tag : ''
            const requested =
              typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 20
            const limit = Math.min(Math.max(1, requested), 100)
            const result = await memorySearch(root, query, tag, limit)
            if (result.length === 0) {
              return { text: 'No matching journal entries found.' }
            }
            return { text: JSON.stringify(result, null, 2) }
          }
          default:
            throw new Error(`memory: unknown action "${action}", expected update/append/search`)
        }
      }
    })
  )
}
