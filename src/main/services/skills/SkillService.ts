/**
 * 技能服务（批次5）：主进程管文件（磁盘 = 真相源），渲染层切片退为投影/缓存。
 *
 * 形态对齐上游 SkillService（876 行）的 MVP 子集：存储 {userData}/Skills/{folderName}/
 * 全局惰性库；安装 = zip 解压（node-stream-zip，100MB/1000 文件限额）/ 目录原位注册 /
 * URL HTTP-zip 下载解压；卸载真删盘；list 扫描解析 frontmatter。裁剪：无 agents DB
 *（skills/agent_skills 表——fork 用 Assistant.enabledSkills 降维）、无 symlink 到
 * agent 工作区（fork 无 Claude Code 工作区概念，上游生效机制是 SDK 文件系统发现，
 * fork 内核用 knowledge_search 同构的 skill 工具）、无遥测、无市场 git clone
 *（claude-plugins/skills.sh 上游走 git——fork 用 HTTP-zip 形态，市场安装留后）。
 *
 * 生效链：渲染层 messageThunk 按 Assistant.enabledSkills ∩ 切片元数据随发送参数
 * 登记（setTurnSkills）；内核 skill 工具执行时按 name/folderName 反查，读 SKILL.md
 * 全文返回（progressive disclosure——模型见 name/description 索引，按需读正文）。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { getDataPath } from '@main/utils'
import StreamZip from 'node-stream-zip'

import { findAllSkillDirectories, findSkillMdPath, parseSkillMetadata, sanitizeFolderName } from './skillMetadata'

const logger = loggerService.withContext('SkillService')

/** SKILL.md 的 SHA-256（切片 contentHash 对齐；无 md 时空串）。 */
function hashSkillMd(skillDir: string): string {
  const mdPath = findSkillMdPath(skillDir)
  if (mdPath === null) return ''
  try {
    return createHash('sha256').update(fs.readFileSync(mdPath)).digest('hex')
  } catch {
    return ''
  }
}

export interface SkillTurnEntry {
  /** 切片里的技能 id（磁盘层不使用，登记一致性用）。 */
  id: string
  folderName: string
  name: string
  description: string
  /** 列表/安装投影用（切片 InstalledSkill 对齐）；登记链路不消费。 */
  contentHash?: string
  author?: string | null
}

/** zip 解压限额（上游同值）。 */
const MAX_EXTRACTED_SIZE = 100 * 1024 * 1024
const MAX_FILES_COUNT = 1000

export class SkillService {
  private static instance: SkillService | null = null

  private turnSkills: Map<string, SkillTurnEntry[]> = new Map()

  static getInstance(): SkillService {
    if (!SkillService.instance) {
      SkillService.instance = new SkillService()
      logger.info('SkillService initialized')
    }
    return SkillService.instance
  }

  private constructor() {}

  private skillsRoot(): string {
    return getDataPath('Skills')
  }

  private skillDir(folderName: string): string {
    return path.join(this.skillsRoot(), sanitizeFolderName(folderName))
  }

  // ===========================================================================
  // 每轮登记（内核 skill 工具执行时反查；同 KnowledgeService.setTurnBases 形态）
  // ===========================================================================

  setTurnSkills(topicId: string, skills: SkillTurnEntry[] | undefined): void {
    if (skills === undefined || skills.length === 0) {
      this.turnSkills.delete(topicId)
    } else {
      this.turnSkills.set(topicId, skills)
    }
  }

  getTurnSkills(topicId: string): SkillTurnEntry[] | undefined {
    return this.turnSkills.get(topicId)
  }

  /** 按技能名或 folderName 读 SKILL.md 全文（工具执行用；磁盘为真相源，内容新鲜）。 */
  async readSkillContent(topicId: string, nameOrFolder: string): Promise<string> {
    const skills = this.getTurnSkills(topicId)
    const entry = skills?.find((skill) => skill.name === nameOrFolder || skill.folderName === nameOrFolder)
    if (entry === undefined) {
      throw new Error(`skill "${nameOrFolder}" is not attached to this conversation turn`)
    }
    const mdPath = findSkillMdPath(this.skillDir(entry.folderName))
    if (mdPath === null) {
      throw new Error(`skill "${entry.name}" has no SKILL.md`)
    }
    return fsp.readFile(mdPath, 'utf-8')
  }

  // ===========================================================================
  // 安装
  // ===========================================================================

  /** 从 zip 安装：解压到临时目录 → 扫描技能目录 → 逐个 installSkillDir。 */
  async installFromZip(zipFilePath: string): Promise<SkillTurnEntry[]> {
    const tempDir = path.join(this.skillsRoot(), `.tmp-${Date.now()}`)
    await fsp.mkdir(tempDir, { recursive: true })
    try {
      const zip = new StreamZip.async({ file: zipFilePath })
      try {
        // node-stream-zip 实现里 entries 是 async 方法（d.ts 同）——漏掉括号时
        // await 得到函数对象本身，Object.keys 恒为空，两道 zip-bomb 防线（文件数
        // /总大小）自上线即失效；oxlint await-thenable 规则抓出（2026-09-22）。
        const entries = await zip.entries()
        if (Object.keys(entries).length > MAX_FILES_COUNT) {
          throw new Error(`skill zip contains too many files (limit ${MAX_FILES_COUNT})`)
        }
        let totalSize = 0
        for (const entry of Object.values(entries)) totalSize += entry.size
        if (totalSize > MAX_EXTRACTED_SIZE) {
          throw new Error(`skill zip is too large (limit ${MAX_EXTRACTED_SIZE / 1024 / 1024}MB)`)
        }
        await zip.extract(null, tempDir)
      } finally {
        await zip.close()
      }
      return await this.installFromDirectory(tempDir, true)
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** 从 URL 下载 zip 再走 zip 安装（市场安装的 HTTP 形态；git clone 不做）。 */
  async installFromUrl(url: string): Promise<SkillTurnEntry[]> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`skill download failed: HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const tempZip = path.join(this.skillsRoot(), `.tmp-${Date.now()}.zip`)
    await fsp.mkdir(this.skillsRoot(), { recursive: true })
    await fsp.writeFile(tempZip, buffer)
    try {
      return await this.installFromZip(tempZip)
    } finally {
      await fsp.rm(tempZip, { force: true }).catch(() => undefined)
    }
  }

  /** 从目录安装/注册：扫描（嵌套布局）→ 逐目录拷贝/原位注册 → 元数据落切片。 */
  async installFromDirectory(directoryPath: string, isTempExtract: boolean = false): Promise<SkillTurnEntry[]> {
    const skillDirs = await findAllSkillDirectories(directoryPath)
    if (skillDirs.length === 0) {
      throw new Error('no skills found (directory must contain SKILL.md)')
    }
    const installed: SkillTurnEntry[] = []
    await fsp.mkdir(this.skillsRoot(), { recursive: true })
    for (const skillDir of skillDirs) {
      const metadata = parseSkillMetadata(skillDir)
      if (metadata === null) continue
      const folderName = sanitizeFolderName(metadata.name)
      const targetDir = this.skillDir(folderName)
      if (!isTempExtract && path.resolve(skillDir) === path.resolve(targetDir)) {
        // 原位注册（用户目录就在库位）。
      } else {
        await fsp.rm(targetDir, { recursive: true, force: true })
        await fsp.mkdir(path.dirname(targetDir), { recursive: true })
        await fsp.cp(skillDir, targetDir, { recursive: true })
      }
      installed.push({
        id: folderName,
        folderName,
        name: metadata.name,
        description: metadata.description,
        contentHash: hashSkillMd(skillDir),
        author: metadata.author ?? null
      })
      logger.info(`skills: installed "${metadata.name}" as ${folderName}`)
    }
    if (installed.length === 0) {
      throw new Error('no valid skills found (SKILL.md frontmatter missing?)')
    }
    return installed
  }

  // ===========================================================================
  // 列表 / 卸载 / 文件读取
  // ===========================================================================

  /** 扫描技能库（磁盘 = 真相源；渲染层切片以本结果整体投影）。 */
  async list(): Promise<SkillTurnEntry[]> {
    const root = this.skillsRoot()
    if (!fs.existsSync(root)) return []
    const skillDirs = await findAllSkillDirectories(root)
    const skills: SkillTurnEntry[] = []
    for (const dir of skillDirs) {
      const metadata = parseSkillMetadata(dir)
      if (metadata === null) continue
      skills.push({
        id: path.basename(dir),
        folderName: path.basename(dir),
        name: metadata.name,
        description: metadata.description,
        contentHash: hashSkillMd(dir),
        author: metadata.author ?? null
      })
    }
    return skills
  }

  async uninstall(folderName: string): Promise<void> {
    const targetDir = this.skillDir(folderName)
    // 防穿越：resolve 后必须在 Skills 根内。
    if (!path.resolve(targetDir).startsWith(path.resolve(this.skillsRoot()))) {
      throw new Error(`invalid skill folder name: ${folderName}`)
    }
    await fsp.rm(targetDir, { recursive: true, force: true })
    logger.info(`skills: uninstalled "${folderName}"`)
  }
}

export const skillService = SkillService.getInstance()
