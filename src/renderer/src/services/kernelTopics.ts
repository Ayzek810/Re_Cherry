/**
 * 话题行的**对账入口**（渲染层唯一）—— v0.3.0-2 目标 B。
 *
 * ## 为什么需要它
 *
 * 话题这个聚合上曾有三份持久化视图：内核会话日志（事件真相源）、内核话题注册表（元数据真相源）、
 * 渲染层 Redux persist（第三份话题行）。旧做法 `shouldShowTopicRow` 是渲染层用**自己那份** persist
 * 去推断**内核那份**的可见性（`updatedAt >= BOOT_TIME` 时间戳启发式）——这与 v0.3.0-1 在事件层
 * 刚刚消灭的"靠治理、不靠结构"是同一个反模式，只是换了轴（那条轴是可见性，这条轴是权威性）。
 *
 * 本模块把成员资格收归内核：**问内核**（`dshTopicList`），渲染层只做两件事——
 * ① 内核有而渲染层无行 → 按内核数据补齐；② 渲染层有而内核无 → 剪除（仅限"上次会话留下来的行"）。
 *
 * ## 「本进程内新建」为什么不算"内核不认识"
 *
 * 新话题在**首次发送**前内核并不知道它（建册发生在 `kernelChat.ensureKernelTopic`）。因此
 * "内核不认识"单独不足以判定失效；判据是"这行是上次会话留下来的"——由 rehydrate 这个显式事件登记
 * （见 `utils/topicBranch.ts` 的 `noteRestoredTopicIds`），**不是**时间戳。
 *
 * ## 失败方向
 *
 * 内核返回"未知"（IPC 失败）时**什么都不做**并返回 `null`：调用方退回渲染层现有行。
 * 宁可多显示一行，也不在没有依据时删用户的行。
 *
 * 背景与验收标准：`report.md` §3（v0.3.0-2 目标 B）。
 */
import { loggerService } from '@logger'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import store from '@renderer/store'
import { addTopic, pruneTopics } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import {
  isRestoredTopicRow,
  KERNEL_QUERY_ATTEMPTS,
  KERNEL_QUERY_DELAY_MS,
  type KernelTopicRow,
  listRootTopics,
  refreshKernelRootTopics,
  retryKernelQuery,
  topicFromKernelRow
} from '@renderer/utils/topicBranch'

const logger = loggerService.withContext('KernelTopics')

/**
 * 取内核成员集合，**带启动窗口重试**（与 `kernelKnowsTopic` 共用 `retryKernelQuery` 与同一组参数）。
 *
 * 为什么必须重试：主进程建窗口与启动内核是**并行**的（`src/main/index.ts`：`createMainWindow()` 之后
 * 才 `bootKernel()`），而 `dsh:*` 的 handler 要等 `initTopics()` 之后才注册——这期间渲染层查询会以
 * "No handler registered" 失败。那是**预期内的瞬时失败**，不是"内核未知"；只试一次的话，
 * 启动窗口内的失败会一直停在"显示全部"直到话题列表变化（真机 2026-09-15 现象）。
 * @param attempts - 最大尝试次数。
 * @param delayMs - 每次尝试之间的等待。
 * @returns 内核根话题；全部失败仍返回 `null`（调用方退回渲染层现有行，绝不据此删行）。
 */
async function fetchKernelRootsWithRetry(
  attempts: number,
  delayMs: number
): Promise<Map<string, KernelTopicRow> | null> {
  const roots = await retryKernelQuery(
    // null（本次没问到）→ undefined（触发重试）；拿到集合（含空集合）= 确定性答案
    async () => (await refreshKernelRootTopics()) ?? undefined,
    { attempts, delayMs }
  )
  if (roots === null) {
    logger.warn(`kernelTopics: kernel topic list unavailable after ${attempts} attempt(s); leaving rows untouched`)
  }
  return roots
}

/**
 * 对账某助手的话题行，返回**应当显示**的根行。
 *
 * 对账动作（都有副作用，均为幂等）：
 * - 剪除"上次会话留下、内核已不认识"的根行（含其后代）→ `pruneTopics`；
 * - 补齐"内核有、渲染层无"的根行 → `addTopic`（字段口径见 `topicFromKernelRow`）；
 * - 若对账后一行不剩（例如某助手的唯一话题行从未首发过），建一个全新的默认话题，
 *   避免出现"零话题"这一没有落点的状态。
 *
 * **不合并存活行的字段**：`name`/`createdAt`/`updatedAt` 等维持渲染层现值——内核自动标题与用户
 * 就地重命名都会经 Redux 回流，在此处用内核值覆盖会与它们竞态（重命名被回滚）。
 *
 * @param assistantId - 目标助手 id；渲染层现状从 store 现读（避免调用方闭包里的陈旧快照）。
 * @param options - 仅用于测试：内核集合查询的尝试次数与间隔。
 * @returns 应当显示的根行；内核成员集合未知时返回 `null`（调用方须退回渲染层现有行）。
 */
export async function reconcileAssistantTopicRows(
  assistantId: string,
  options?: { attempts?: number; delayMs?: number }
): Promise<Topic[] | null> {
  const assistant = store.getState().assistants.assistants.find((row) => row.id === assistantId)
  if (assistant === undefined) return null

  const kernelRoots = await fetchKernelRootsWithRetry(
    options?.attempts ?? KERNEL_QUERY_ATTEMPTS,
    options?.delayMs ?? KERNEL_QUERY_DELAY_MS
  )
  if (kernelRoots === null) return null

  const localRoots = listRootTopics(assistant.topics ?? [])
  const localById = new Map(localRoots.map((row) => [row.id, row]))

  // ① 剪除：上次会话留下、内核已不认识的根行（本进程内新建的行一律不动）
  const stale = localRoots.filter((row) => isRestoredTopicRow(row.id) && !kernelRoots.has(row.id))
  if (stale.length > 0) {
    store.dispatch(pruneTopics({ assistantId: assistant.id, topicIds: stale.map((row) => row.id) }))
    logger.info(
      `kernelTopics: pruned ${stale.length} stale topic row(s) of assistant "${assistant.id}" (unknown to the kernel registry)`
    )
  }

  // ② 补齐：内核有、渲染层无 —— 行内容只能来自内核（含 ms → ISO 换算）
  const shown: Topic[] = []
  for (const kernelRow of kernelRoots.values()) {
    const local = localById.get(kernelRow.id)
    if (local !== undefined) {
      shown.push(local)
      continue
    }
    const materialized = topicFromKernelRow(kernelRow, assistant.id)
    store.dispatch(addTopic({ assistantId: assistant.id, topic: materialized }))
    logger.info(`kernelTopics: materialized missing topic row "${kernelRow.id}" of assistant "${assistant.id}"`)
    shown.push(materialized)
  }

  // ③ 本进程内新建、尚未建册的行：内核不认识它们是"因为刚建"，必须显示
  for (const row of localRoots) {
    if (kernelRoots.has(row.id) || isRestoredTopicRow(row.id)) continue
    shown.push(row)
  }

  // ④ 兜底：对账不能留下"零话题"状态（侧栏与输入栏都按"至少一行"设计）
  if (shown.length === 0) {
    const fresh = getDefaultTopic(assistant.id)
    store.dispatch(addTopic({ assistantId: assistant.id, topic: fresh }))
    logger.info(`kernelTopics: assistant "${assistant.id}" had no surviving topic row; created a fresh one`)
    shown.push(fresh)
  }

  return shown
}
