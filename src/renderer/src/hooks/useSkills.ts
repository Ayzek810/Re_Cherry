/**
 * v0.3.2 批次5（接线）：技能 hooks 接主进程 SkillService（磁盘 = 真相源）。
 *
 * fork 生效形态：上游 v1.9.11 = Claude Code SDK 文件系统发现（symlink 到 agent
 * 工作区），fork 无该工作区——内核 skill 工具 + 每轮登记（progressive disclosure，
 * 见 kernel/skillTool.ts）。本模块职责：
 * - refresh：主进程扫描 {userData}/Skills/ 全量投影进切片（setInstalledSkills 整体替换）；
 * - uninstall：主进程真删盘 + 切片移除；
 * - installFromZip / installFromDirectory：主进程解压/拷贝安装 + 切片增量；
 * - install（市场）：MVP 走 GitHub archive HTTP-zip（sourceUrl 是 GitHub 仓库时），
 *   仓库 zip 内全部技能一并入库（按目录精确安装留后）；无 GitHub sourceUrl 时诚实提示。
 * toggle 仍保留 batch-1 语义：per-agent 启用态走助手设置面板（Assistant.enabledSkills），
 * 本 hook 无 agent 上下文，无操作返回 false（非"待接线"，是形态即如此）。
 */
import { loggerService } from '@logger'
import { searchSkills } from '@renderer/services/SkillSearchService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addInstalledSkill, removeInstalledSkills, setInstalledSkills } from '@renderer/store/skills'
import type { InstalledSkill, SkillSearchResult } from '@types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('useSkills')

type MainSkillEntry = {
  id: string
  folderName: string
  name: string
  description: string
  contentHash?: string
  author?: string | null
}

/** 主进程扫描/安装结果 → 切片 InstalledSkill 投影（id = folderName，磁盘映射用）。 */
const projectSkill = (entry: MainSkillEntry, source: string, sourceUrl: string | null): InstalledSkill => ({
  id: entry.folderName,
  name: entry.name,
  description: entry.description.length > 0 ? entry.description : null,
  folderName: entry.folderName,
  source,
  sourceUrl,
  namespace: null,
  author: entry.author ?? null,
  tags: [],
  contentHash: entry.contentHash ?? '',
  isEnabled: false,
  createdAt: Date.now(),
  updatedAt: Date.now()
})

/**
 * Hook to manage installed skills.
 *
 * Pass `agentId` to get per-agent enablement state and to scope toggle calls
 * to that agent. Without `agentId`, the hook returns the global skill library
 * with `isEnabled` forced to false — callers without an agent context (e.g.
 * the global Settings → Skills page) should rely on uninstall only.
 */
export function useInstalledSkills(agentId?: string) {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  // fork：切片是主进程扫描的投影（refresh 整体覆盖）；选择器实时反映。
  const skills = useAppSelector((state) => state.skills.installedSkills)
  // r2-38：真实反映扫描过程/结果。此前两者硬编码为 `false`/`null`，主进程扫描失败时切片保持
  // 原状（首次进入即空），页面只能渲染"未安装任何技能"——失败看起来像空结果（§9 违规）。
  // 契约（W4-2）：`loading` 初值为 `true` ⇒ **调用方必须在挂载时触发一次 `refresh()`**。
  // 技能页曾漏掉这一步，表现为首次进入永久转圈（r2-38 之前硬编码 `false` 把这个漏接线掩住了）。
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 主进程全量扫描 → 切片整体投影（磁盘 = 真相源）。失败必须可见（error + toast），不静默。 */
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const entries = (await window.api.skills.list()) as MainSkillEntry[]
      dispatch(setInstalledSkills(entries.map((entry) => projectSkill(entry, 'local', null))))
      if (mountedRef.current) {
        setError(null)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('skills: refresh failed', err instanceof Error ? err : new Error(message))
      if (mountedRef.current) {
        setError(message)
      }
      // 用户可见信号：安装/卸载路径同样 toast（本 hook 的 :103 等处）。
      window.toast.error(t('settings.skills.refreshFailed'))
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [dispatch, t])

  const toggle = useCallback(
    async (skillId: string, isEnabled: boolean) => {
      if (!agentId) {
        // Without an agent context there is nothing to toggle — per-agent
        // enablement has no target. Callers that want to toggle must scope
        // to an agent.
        return false
      }
      // fork：per-agent 启用态（Assistant.enabledSkills）在助手设置面板维护，
      // 本 hook（全局技能库页）无 agent 上下文，无操作。
      logger.warn('skill toggle requires an agent context', { skillId, isEnabled })
      window.toast.info(t('settings.skills.toggleNeedsAgent'))
      return false
    },
    [agentId, t]
  )

  const uninstall = useCallback(
    async (skillId: string) => {
      try {
        // 磁盘真删盘（id = folderName，投影约定）；失败则不落切片移除。
        await window.api.skills.uninstall(skillId)
        dispatch(removeInstalledSkills([skillId]))
        return true
      } catch (err) {
        logger.error('skills: uninstall failed', err instanceof Error ? err : new Error(String(err)))
        window.toast.error(t('settings.skills.uninstallFailed', { id: skillId }))
        return false
      }
    },
    [dispatch, t]
  )

  return { skills, loading, error, refresh, toggle, uninstall }
}

/**
 * Hook for searching skills across all 3 registries.
 */
export function useSkillSearch() {
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(0)

  const search = useCallback(async (query: string) => {
    const requestId = ++abortRef.current

    if (!query.trim()) {
      setResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    setError(null)

    try {
      // r2-07：`searchSkills` 现返回判别式 `{ results, failed }`（失败的源不再被伪装成"成功但空"）。
      const { results: found, failed } = await searchSkills(query)
      if (requestId === abortRef.current) {
        setResults(found)
        setError(failed.length > 0 && found.length === 0 ? `skill search failed: ${failed.join(', ')}` : null)
      }
    } catch (err) {
      if (requestId === abortRef.current) {
        setError(err instanceof Error ? err.message : 'Search failed')
      }
    } finally {
      if (requestId === abortRef.current) {
        setSearching(false)
      }
    }
  }, [])

  const clear = useCallback(() => {
    abortRef.current++
    setResults([])
    setSearching(false)
    setError(null)
  }, [])

  return { results, searching, error, search, clear }
}

/** GitHub 仓库 URL → HEAD archive zip（fork 市场安装形态：HTTP-zip，零 git 依赖）。 */
const githubArchiveUrl = (sourceUrl: string): string | null => {
  const match = sourceUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/)
  if (match === null) return null
  return `https://github.com/${match[1]}/${match[2]}/archive/HEAD.zip`
}

/**
 * Hook for installing a skill from search results / zip / directory.
 */
export function useSkillInstall() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const [installingKey, setInstallingKey] = useState<string | null>(null)

  /** 安装结果（可多条）投影进切片，返回第一条供页面提示。 */
  const commitEntries = useCallback(
    (entries: MainSkillEntry[], source: string, sourceUrl: string | null): InstalledSkill | null => {
      let first: InstalledSkill | null = null
      for (const entry of entries) {
        const projected = projectSkill(entry, source, sourceUrl)
        dispatch(addInstalledSkill(projected))
        first ??= projected
      }
      return first
    },
    [dispatch]
  )

  const install = useCallback(
    async (result: SkillSearchResult): Promise<{ skill: InstalledSkill | null; error?: string }> => {
      setInstallingKey(result.installSource)
      try {
        // fork 市场安装 MVP：GitHub archive HTTP-zip（仓库内全部技能一并入库，
        // 按目录精确安装留后——交付注记有记）；无 GitHub sourceUrl 时诚实提示。
        const archive = result.sourceUrl === null ? null : githubArchiveUrl(result.sourceUrl)
        if (archive === null) {
          window.toast.info(t('settings.skills.marketInstallUnsupported'))
          return { skill: null }
        }
        const entries = (await window.api.skills.installFromUrl(archive)) as MainSkillEntry[]
        const skill = commitEntries(entries, result.sourceRegistry, result.sourceUrl)
        return { skill }
      } catch (err) {
        logger.error('skills: market install failed', err instanceof Error ? err : new Error(String(err)))
        return { skill: null, error: err instanceof Error ? err.message : String(err) }
      } finally {
        setInstallingKey(null)
      }
    },
    [commitEntries, t]
  )

  const installFromZip = useCallback(
    async (zipFilePath: string): Promise<InstalledSkill | null> => {
      setInstallingKey('zip')
      try {
        const entries = (await window.api.skills.installFromZip(zipFilePath)) as MainSkillEntry[]
        return commitEntries(entries, 'zip', null)
      } catch (err) {
        logger.error('skills: zip install failed', err instanceof Error ? err : new Error(String(err)))
        window.toast.error(`${t('settings.skills.installFailed')}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      } finally {
        setInstallingKey(null)
      }
    },
    [commitEntries, t]
  )

  const installFromDirectory = useCallback(
    async (directoryPath: string): Promise<InstalledSkill | null> => {
      setInstallingKey('directory')
      try {
        const entries = (await window.api.skills.installFromDirectory(directoryPath)) as MainSkillEntry[]
        return commitEntries(entries, 'local', null)
      } catch (err) {
        logger.error('skills: directory install failed', err instanceof Error ? err : new Error(String(err)))
        window.toast.error(`${t('settings.skills.installFailed')}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      } finally {
        setInstallingKey(null)
      }
    },
    [commitEntries, t]
  )

  const isInstalling = useCallback(
    (key?: string) => {
      if (!installingKey) return false
      if (!key) return !!installingKey
      return installingKey === key
    },
    [installingKey]
  )

  return { installingKey, isInstalling, install, installFromZip, installFromDirectory }
}
