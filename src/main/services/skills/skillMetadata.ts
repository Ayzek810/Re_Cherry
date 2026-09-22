/**
 * 技能元数据解析（批次5 自 CS_V1 src/main/utils/markdownParser.ts 移植 + 裁剪）。
 *
 * SKILL.md frontmatter：name/description/tools/tags/version/author（gray-matter +
 * failsafe YAML，防反序列化攻击）；正文 = 指令。SKILL.md 或 skill.md 大小写均可。
 * fork 裁剪：只保留技能库扫描/解析所需（findAllSkillDirectories/findSkillMdPath/
 * parseSkillMetadata/sanitize），上游 markdownParser 其余（AGENT.md 等）不移植。
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import { loggerService } from '@logger'
import matter from 'gray-matter'

const logger = loggerService.withContext('SkillMetadata')

export const SKILL_MD_FILENAME = 'SKILL.md'

/** 目录名 sanitize：[a-zA-Z0-9_-]，≤80 字符（上游同规则）。 */
export function sanitizeFolderName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'skill'
}

/** 在技能目录里找 SKILL.md（大小写均可）。 */
export function findSkillMdPath(skillDir: string): string | null {
  for (const candidate of [SKILL_MD_FILENAME, SKILL_MD_FILENAME.toLowerCase()]) {
    const candidatePath = path.join(skillDir, candidate)
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath
    }
  }
  return null
}

export interface ParsedSkillMetadata {
  name: string
  description: string
  version?: string
  author?: string
}

/** 解析 SKILL.md frontmatter（name/description 缺失时回退目录名/空串，不抛）。 */
export function parseSkillMetadata(skillDir: string): ParsedSkillMetadata | null {
  const mdPath = findSkillMdPath(skillDir)
  if (mdPath === null) return null
  try {
    const raw = fs.readFileSync(mdPath, 'utf-8')
    const parsed = matter(raw, {})
    const data = (parsed.data ?? {}) as Record<string, unknown>
    return {
      name: typeof data.name === 'string' && data.name.trim().length > 0 ? data.name.trim() : path.basename(skillDir),
      description: typeof data.description === 'string' ? data.description.trim() : '',
      version: typeof data.version === 'string' ? data.version : undefined,
      author: typeof data.author === 'string' ? data.author : undefined
    }
  } catch (error) {
    logger.warn(
      `skills: failed to parse metadata in "${skillDir}"`,
      error instanceof Error ? error : new Error(String(error))
    )
    return null
  }
}

/**
 * 在根目录下扫描技能目录（深度 ≤8：目录含 SKILL.md 即算技能，含嵌套仓库布局——
 * zip 安装的仓库根常有 skills/<name>/SKILL.md 层级，上游 findAllSkillDirectories 同语义）。
 */
export async function findAllSkillDirectories(root: string, maxDepth = 8): Promise<string[]> {
  const results: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (findSkillMdPath(dir) !== null) {
      results.push(dir)
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(path.join(dir, entry.name), depth + 1)
      }
    }
  }
  await walk(root, 0)
  return results
}
