import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 结构门禁（v0.3.0-2 目标 B，`report.md` §3.4 的 B-1 / B-2）：把"话题成员资格问内核"钉成
 * 可执行断言，而不是靠后来者自觉。
 *
 * 背景：`shouldShowTopicRow` 用 `updatedAt >= BOOT_TIME` 这一时间戳启发式，在渲染层用**自己那份**
 * persist 推断**内核那份**的可见性。它已整体退役，替换为
 * `utils/topicBranch.ts`（取内核集合）+ `services/kernelTopics.ts`（对账：补齐 / 剪除）。
 * 本门禁守三条：① 退役符号零残留；② 裸通道只有权威层能碰；③ 显示层只消费 store——
 * 侧栏/管理模式不持对账快照、不问内核（v0.3.1：旧快照是注册表序，杀拖拽/滞显/乱跳三宗罪），
 * 对账伞盖钉在 useTopic（切助手/开聊天必然执行），把对账写进 store 的结果自然反映到派生列表。
 */
const RAW_CHANNEL = 'window.api.dshTopicList'
/** 允许直接问内核集合的模块（权威层 + 它的两个异步消费者）。 */
const AUTHORITY_MODULES = new Set([
  'src/renderer/src/utils/topicBranch.ts',
  'src/renderer/src/services/kernelTopics.ts'
])
/** 允许读内核集合判"这一行还在不在"的调用方（发送前的墓碑判定 / 启动落点判定）。 */
const ALLOWED_KERNEL_SET_READERS = new Set([
  ...AUTHORITY_MODULES,
  'src/renderer/src/hooks/useTopic.ts',
  'src/renderer/src/services/kernelChat.ts'
])
/** 已退役的符号（含旧的带缓存取数入口）。 */
const RETIRED_SYMBOLS = ['shouldShowTopicRow', 'BOOT_TIME', 'loadKernelTopicRootIds']

const repoRoot = process.cwd()

function listSourceFiles(relativeDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在视为空
    }
    for (const entry of entries) {
      const full = dir + sep + entry.name
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) found.push(full)
    }
  }
  walk(repoRoot + sep + relativeDir)
  return found
}

const relativeToRepo = (absolute: string): string => relative(repoRoot, absolute).split(sep).join('/')

/**
 * 去掉注释后的源码——门禁看的是**真正的代码引用**：在注释里说明"旧做法为什么退役"是合法的、
 * 也应当保留（否则后来者看不懂替换的动机）。字符串不做掩码，因为受检符号都是标识符，
 * 除本条测试自身的常量表外不会出现在字符串里（`__tests__` 已整体跳过）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 跳过测试文件：它们可以合法地点名已退役的符号。 */
const SOURCE_FILES = listSourceFiles('src')
const PRODUCTION_FILES = SOURCE_FILES.filter((file) => !relativeToRepo(file).includes('__tests__'))

describe('话题权威结构门禁', () => {
  it('退役符号零残留（B-1：全库、含别名/相对/barrel 三种引用形态）', () => {
    const offenders: string[] = []
    for (const file of PRODUCTION_FILES) {
      const repoPath = relativeToRepo(file)
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const symbol of RETIRED_SYMBOLS) {
        if (source.includes(symbol)) offenders.push(`${repoPath} → ${symbol}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('裸通道只有权威层能碰，且内核集合只在两个异步判定点被读（B-2）', () => {
    const channelOffenders: string[] = []
    const readerOffenders: string[] = []
    for (const file of PRODUCTION_FILES) {
      const repoPath = relativeToRepo(file)
      const source = readFileSync(file, 'utf8')
      if (repoPath !== 'src/renderer/src/utils/topicBranch.ts' && source.includes(RAW_CHANNEL)) {
        channelOffenders.push(repoPath)
      }
      const readsKernelSet =
        source.includes('kernelRootTopics(') ||
        source.includes('refreshKernelRootTopics(') ||
        source.includes('kernelKnowsTopic(')
      if (readsKernelSet && !ALLOWED_KERNEL_SET_READERS.has(repoPath)) readerOffenders.push(repoPath)
    }
    expect(channelOffenders).toEqual([])
    expect(readerOffenders).toEqual([])
  })

  it('侧栏只消费 store（不持对账快照、不自问内核），对账伞盖在 useTopic（B-3/B-4 落点，v0.3.1）', () => {
    const sidebar = readFileSync(repoRoot + sep + 'src/renderer/src/pages/home/Tabs/components/Topics.tsx', 'utf8')
    // 列表单源派生自 Redux 数组：名字/顺序的写入从此立刻反映到侧栏
    expect(sidebar).toContain('listRootTopics(')
    // 显示层绝不自问内核、也不持"注册表序"快照（快照曾让拖拽被吞、名字滞显、顺序乱跳）
    expect(sidebar).not.toContain('reconcileAssistantTopicRows')
    expect(sidebar).not.toContain('kernelRootTopics(')
    // 不得再出现"用内核集合过滤自持久化数组"的写法
    expect(sidebar).not.toContain('.filter((topic) => kernelRoots')

    const manage = readFileSync(
      repoRoot + sep + 'src/renderer/src/pages/home/Tabs/components/TopicManageMode.tsx',
      'utf8'
    )
    expect(manage).not.toContain('reconcileAssistantTopicRows')
    expect(manage).not.toContain('kernelRootTopics')

    // 对账伞盖（sidebar 释放调用后全靠这里；不得被顺手删掉）
    const umbrella = readFileSync(repoRoot + sep + 'src/renderer/src/hooks/useTopic.ts', 'utf8')
    expect(umbrella).toContain('reconcileAssistantTopicRows(')
  })
})
