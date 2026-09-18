/**
 * 话题自动命名（渲染层调度，v0.3.1）。
 *
 * 命名管线回归 V1 原理：**轻量调用 + 用户可控**——
 * - 走 `fetchMessagesSummary`（快速模型 + `topicNamingPrompt` 设置项/默认指令，经 lightComplete
 *   一次往返，无会话残留、思考缺省 off）；
 * - `enableTopicNaming` 关 = 不调模型，直接用首条用户消息截断文本兜底（V1 同款）；
 * - 门全按 V1：手动改过名永不自动盖、仅默认名话题触发、消息数 ≥2；
 * - fork 分支行不自动命名（保持 dsh 时代的语义：分支是手动/继承物，不是独立对话）。
 *
 * 触发点：kernelChat 的 turn/end（成功回合）。与（已移除的）DSH SessionTitleService 的区别：
 * 服务/路由/指令全部在用户可见的设置面（快速模型 + 命名提示词框），而不是内核包里写死。
 *
 * 落名走两条（缺一不可）：
 * - Redux `updateTopicName`（免 bump 专属 action）：名字是标签不是活动，bump 会翻转
 *   familyRowSignature 导致页码条/分支图全家族重取（v0.3.1 对话树数字连跳的根治位）；
 * - `Dsh_TopicRename`（内核注册表）：重启恢复时 reconcile 只在"物化缺行"时读注册表名，
 *   存活行的显示名以 Redux 为准（kernelTopics.ts 的既定契约），注册表名是恢复语义的权威。
 *   手动改名（本文件 `syncTopicNameToKernel` 的所有调用点）同一规则。
 */
import { loggerService } from '@logger'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import i18n from '@renderer/i18n'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import store from '@renderer/store'
import { updateTopicName } from '@renderer/store/assistants'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'
import { truncateText } from '@renderer/utils/naming'

const logger = loggerService.withContext('TopicNaming')

/** 命名去重锁：同一话题同时只跑一次（V1 topicRenamingLocks 同款）。 */
const inflight = new Set<string>()

/** 跨助手按 id 找话题行（注册表/Redux 的话题行只有一个持有者，但历史数据可能多持有，全查）。 */
function findTopicRow(topicId: string) {
  for (const assistant of store.getState().assistants.assistants) {
    const row = (assistant.topics ?? []).find((topic) => topic.id === topicId)
    if (row !== undefined) return row
  }
  return undefined
}

/** V1 首条消息兜底名：主文本块拼接 + 语义边界截断。无文本返回空串（调用方据此放弃）。 */
function firstMessageName(messages: Message[]): string {
  const first = messages[0]
  if (first === undefined) return ''
  const text = findMainTextBlocks(first)
    .map((block) => block.content)
    .join('\n\n')
    .trim()
  return truncateText(text)
}

/**
 * 把名字写进内核注册表（`Dsh_TopicRename`）。
 * fire-and-forget：注册表是恢复语义的权威，不是显示的权威——失败只记日志，绝不该反过来
 * 阻塞或回滚渲染层（对账只在物化缺行时读它，见 kernelTopics.ts）。
 */
export function syncTopicNameToKernel(topicId: string, name: string): void {
  if (name.length === 0) return
  window.api.dshTopicRename(topicId, name).catch((error: unknown) => {
    logger.warn(
      'topicNaming: registry rename failed for topic ' + topicId,
      error instanceof Error ? error : new Error(String(error))
    )
  })
}

/**
 * 回合成功结束后的话题自动命名入口（kernelChat turn/end 触发，fire-and-forget）。
 * 门（V1 语义，全过才命名）：
 *   ① 行存在；② 未手动改过名；③ 非分支行；④ 名字仍是默认占位；⑤ 消息数 ≥2。
 * 名字来源：`enableTopicNaming` 开 → fetchMessagesSummary（失败/为空降级到兜底）；
 * 关 → 兜底（首条用户消息截断，不调模型）。最终为空则什么都不写。
 */
export async function autoNameKernelTopic(topicId: string): Promise<void> {
  if (inflight.has(topicId)) return
  inflight.add(topicId)
  try {
    const row = findTopicRow(topicId)
    if (row === undefined) return
    if (row.isNameManuallyEdited) return
    if (row.parentTopicId !== undefined) return
    if (row.name !== i18n.t('chat.default.topic.name')) return

    const messages = selectMessagesForTopic(store.getState(), topicId)
    if (messages.length < 2) return

    let name = ''
    if (getStoreSetting('enableTopicNaming')) {
      try {
        const { text } = await fetchMessagesSummary({ messages })
        name = (text ?? '').trim()
      } catch (error) {
        // 后台自动动作不弹 toast（要醒目去用手动"自动命名"菜单）；降级到兜底
        logger.warn(
          'topicNaming: summary call failed for topic ' + topicId,
          error instanceof Error ? error : new Error(String(error))
        )
      }
    }
    if (name.length === 0) name = firstMessageName(messages)
    if (name.length === 0) return

    store.dispatch(updateTopicName({ topicId, name }))
    syncTopicNameToKernel(topicId, name)
    logger.debug('topicNaming: auto-named topic ' + topicId)
  } finally {
    inflight.delete(topicId)
  }
}
