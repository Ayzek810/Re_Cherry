import { loggerService } from '@logger'
import { fetchTopicEventsWithRetry } from '@renderer/services/kernelEventStream'
import { type CMFamily, loadFamily } from '@renderer/utils/conversationModel'
import { retryKernelQuery } from '@renderer/utils/topicBranch'

const logger = loggerService.withContext('ConversationTreeCache')

interface Entry {
  signature: string
  promise: Promise<CMFamily>
}

const cache = new Map<string, Entry>()

/**
 * 家族取数的短重试窗口（刻意不共用 KERNEL_QUERY_ATTEMPTS × KERNEL_QUERY_DELAY_MS）：
 * 主进程 `Dsh_TopicEvents` 有一个已知的瞬时失败源——`tree.open(id)` 在重启后的异步
 * resume 未完成时会抛 "session is not loaded"（见 src/main/kernel/index.ts handler 注释）。
 * 家族加载是**每分支一次**的取数，成员查询那套 6×700ms 是每族一次的口径；N 个分支
 * 乘上启动常量会把最坏时延放大一个数量级，这里用 3×400ms 覆盖瞬时抖动即可。
 */
const FAMILY_FETCH_ATTEMPTS = 3
const FAMILY_FETCH_DELAY_MS = 400

/**
 * 唯一家族取数入口（结构层统一）：按根话题缓存；signature 变化才重取。
 *
 * 失败语义（分支图"节点凭空消失"的根因修复）：**拉取失败绝不吞成空集合**。
 * 空数组/空列表是"确定性答案"（该分支真的没有对话），而拉取失败是"不知道"——
 * 后者伪装成前者时，该分支在图上一个节点都不剩（消息区走 Redux 投影照常渲染，
 * 症状即"UI 还有、图里没了"）。失败的重试窗口用尽后让整棵家族加载 reject，
 * 由调用方保留旧渲染或显式报错；失败结果也不进缓存，同签名重试是真重试。
 */
export function loadConversationTree(rootTopicId: string, signature: string): Promise<CMFamily> {
  const existing = cache.get(rootTopicId)
  if (existing && existing.signature === signature) return existing.promise

  const promise = loadFamily(rootTopicId, {
    listBranches: async () => {
      const topics = await retryKernelQuery(
        async () => {
          try {
            const { topics: rows } = (await window.api.dshTopicBranches(rootTopicId)) as {
              topics: Array<{ id: string; name?: string; parentTopicId?: string }>
            }
            // 空集合是确定性答案（家族只有根自己），不重试
            return rows
          } catch (error) {
            logger.warn(
              'failed to list branches of ' + rootTopicId,
              error instanceof Error ? error : new Error(String(error))
            )
            return undefined
          }
        },
        { attempts: FAMILY_FETCH_ATTEMPTS, delayMs: FAMILY_FETCH_DELAY_MS }
      )
      if (topics === null) {
        throw new Error('conversationTree: branch list unavailable for ' + rootTopicId)
      }
      return topics
    },
    sessionEvents: async (id) => {
      // UI 视界取数（唯一入口）：注入的插件源消息已在内核侧剔除。
      // 确定性"内核无此行" → 空会话（真实状态，不是失败）；瞬时失败 → 短窗口重试
      //（每分支一次的批式取数，刻意收窄到 3×400，见上方常量注释）；
      // 窗口用尽 → null → 整棵家族 reject，绝不渲染缺分支的假树（见函数头注释）。
      const events = await fetchTopicEventsWithRetry(id, {
        attempts: FAMILY_FETCH_ATTEMPTS,
        delayMs: FAMILY_FETCH_DELAY_MS
      })
      if (events === null) {
        throw new Error('conversationTree: session events unavailable for ' + id)
      }
      return events
    }
  })

  cache.set(rootTopicId, { signature, promise })
  // reject 的结果不留在缓存：按签名缓存一个坏 promise，同签名的后续取数（重开抽屉等）
  // 会一直拿到同一次失败直到签名变化。移除后下一次同签名访问会真正重新拉取。
  void promise.catch(() => {
    if (cache.get(rootTopicId)?.promise === promise) {
      cache.delete(rootTopicId)
    }
  })
  return promise
}
