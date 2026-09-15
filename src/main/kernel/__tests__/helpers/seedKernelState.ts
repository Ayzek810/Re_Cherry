/**
 * **测试专用**：在临时目录里播种"内核启动时看到的状态"（注册表文件 + 会话库）。
 *
 * 为什么需要它（`report.md` §4.1）：用户的旧数据已清理，M1'–M6' 里那几项依赖的
 * "库里有会话 / 注册表里没有"这一状态**无法用真实历史数据构造**，而凡是"内核读文件 / 读库之后的行为"
 * 都不需要 Electron 渲染进程——只需要能自己造出那个状态。本 helper 一次建成，同时服务
 * D 的验收（验D-1/3/4）与 M2'/M4'/M5' 的机测替代。
 *
 * 纪律（`report.md` §4.4）：本模块**不得**有任何"默认写用户真实数据目录"的路径——`dir` 必填，
 * 测试必须自己传 `mkdtemp` 出来的临时目录。生产代码不引用本模块（它在 `__tests__` 下）。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 注册表文件的三种形态：合法（含指定行）/ 缺失 / 损坏（非法 JSON）。 */
export type SeededRegistry = { topics: Array<Record<string, unknown>> } | 'absent' | 'corrupt'

export interface SeedKernelStateOptions {
  /** 临时 userData 目录（调用方用 {@link createTempUserData} 造）。 */
  dir: string
  /** 注册表形态；缺省 `{ topics: [] }`（合法空注册表）。 */
  registry?: SeededRegistry
  /** 播种的会话：id + 事件条数（缺省 1 条）。 */
  sessions?: Array<{ id: string; events?: number }>
  /** 注册表中额外写入的行（与 `sessions` 独立，便于造"注册表有行但库里没会话"等组合）。 */
  topicRows?: Array<Record<string, unknown>>
}

/** 造一个临时 userData 目录（`<tmp>/rc-kernel-XXXXXX`）。 */
export async function createTempUserData(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'rc-kernel-'))
}

const kernelDir = (dir: string): string => join(dir, 'kernel')
export const registryFile = (dir: string): string => join(kernelDir(dir), 'topics.json')
export const sessionsDbFile = (dir: string): string => join(kernelDir(dir), 'sessions.db')

/**
 * 写入注册表文件与（可选的）会话库。
 * @param options - 见 {@link SeedKernelStateOptions}；`dir` 必填。
 */
export async function seedKernelState(options: SeedKernelStateOptions): Promise<void> {
  await mkdir(kernelDir(options.dir), { recursive: true })

  const registry = options.registry ?? { topics: [] }
  const file = registryFile(options.dir)
  if (registry === 'absent') {
    // 什么都不写
  } else if (registry === 'corrupt') {
    // 典型损坏：写到一半被截断（JSON 不完整）
    await writeFile(file, '{\n  "topics": [\n    { "id": "truncated", "name": "坏掉的注册表"', 'utf8')
  } else {
    await writeFile(
      file,
      JSON.stringify({ topics: [...registry.topics, ...(options.topicRows ?? [])] }, null, 2),
      'utf8'
    )
  }

  if (options.sessions !== undefined && options.sessions.length > 0) {
    await writeSessions(options.dir, options.sessions)
  }
}

/** 用 `node:sqlite` 建一个最小的 `sessions` / `events` 两表结构并写入会话（表形状对齐内核实际用法）。 */
async function writeSessions(dir: string, sessions: Array<{ id: string; events?: number }>): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionsDbFile(dir))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version INTEGER, created_at INTEGER)')
    db.exec(
      'CREATE TABLE IF NOT EXISTS events (session_id TEXT, seq INTEGER, type TEXT, data TEXT, ignorable INTEGER, PRIMARY KEY (session_id, seq))'
    )
    const insertSession = db.prepare('INSERT INTO sessions (id, version, created_at) VALUES (?, 0, ?)')
    const insertEvent = db.prepare(
      'INSERT INTO events (session_id, seq, type, data, ignorable) VALUES (?, ?, ?, ?, NULL)'
    )
    for (const session of sessions) {
      insertSession.run(session.id, Date.now())
      const count = session.events ?? 1
      for (let seq = 0; seq < count; seq += 1) {
        insertEvent.run(session.id, seq, 'user/message', JSON.stringify({ text: `${session.id}#${seq}` }))
      }
    }
  } finally {
    db.close()
  }
}

/** 库里两种表的行数（用于"清扫前/后"的计数断言，不用耗时类信号）。 */
export async function readSessionCounts(dir: string): Promise<{ sessions: number; events: number }> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionsDbFile(dir), { readOnly: true })
  try {
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return { sessions: Number(sessions.n), events: Number(events.n) }
  } finally {
    db.close()
  }
}

/** 库里的会话 id 列表（升序）。 */
export async function readSessionIds(dir: string): Promise<string[]> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(sessionsDbFile(dir), { readOnly: true })
  try {
    const rows = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  } finally {
    db.close()
  }
}

/** 读回注册表文件的原始字节（供"字节未变"的断言）。 */
export async function readRegistryBytes(dir: string): Promise<Buffer> {
  return await readFile(registryFile(dir))
}

/** 注册表文件里当前的 topic id 列表（文件不存在时返回 `null`）。 */
export async function readRegistryTopicIds(dir: string): Promise<string[] | null> {
  try {
    const raw = await readFile(registryFile(dir), 'utf8')
    const parsed = JSON.parse(raw) as { topics?: Array<{ id: string }> }
    return (parsed.topics ?? []).map((row) => row.id)
  } catch {
    return null
  }
}

/** 损坏备份文件列表（`topics.json.corrupt-*`）。 */
export async function listCorruptBackups(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(kernelDir(dir))).filter((name) => name.startsWith('topics.json.corrupt-')).sort()
}

/** 读回某份损坏备份的字节（用于"备份内容与原文件逐字节相同"的断言）。 */
export async function readCorruptBackupBytes(dir: string, name: string): Promise<Buffer> {
  return await readFile(join(kernelDir(dir), name))
}
