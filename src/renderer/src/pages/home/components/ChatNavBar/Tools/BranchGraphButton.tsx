import { HistoryOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import NavbarIcon from '@renderer/components/NavbarIcon'
import BranchGraph from '@renderer/pages/home/Messages/BranchGraph'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic, selectAllTopics } from '@renderer/store/assistants'
import type { Assistant, Topic } from '@renderer/types'
import {
  branchKindsOf,
  familyRowSignature,
  listRootTopics,
  materializeKernelTopicRow,
  requestTopicSwitch,
  retryKernelQuery,
  rootTopicOf
} from '@renderer/utils/topicBranch'
import { Drawer, message as antdMessage, Tooltip } from 'antd'
import { t } from 'i18next'
import { useMemo, useState } from 'react'
import styled from 'styled-components'

const logger = loggerService.withContext('BranchGraphButton')

interface Props {
  assistant?: Assistant
  topic?: Topic
  onSwitchTopic?: (topic: Topic) => void
}

/**
 * 沿内核血缘（parentTopicId）找到真正的家族根 —— 不依赖渲染层 Topic 行，行缺链/陈旧不影响。
 * 每一跳带启动窗口重试（retryKernelQuery）：重启后用户往往立刻点分支图，单次 dshTopicGet
 * 会在 handler 注册前失败一次；确定性答案（含"内核明确回答无此行"）不重试。
 */
async function kernelRootOf(topicId: string): Promise<{ id: string; name?: string } | null> {
  const seen = new Set<string>()
  let id = topicId
  while (!seen.has(id)) {
    seen.add(id)
    const answer = await retryKernelQuery<{ id: string; name?: string; parentTopicId?: string } | null>(async () => {
      try {
        const { topic: kernelTopic } = (await window.api.dshTopicGet(id)) as {
          topic?: { id: string; name?: string; parentTopicId?: string }
        }
        return kernelTopic ?? null
      } catch (error) {
        logger.warn('kernel root walk failed at ' + id, error as Error)
        return undefined
      }
    })
    if (answer === null) return null
    if (!answer.parentTopicId || answer.parentTopicId.length === 0) {
      return { id: answer.id, name: answer.name }
    }
    id = answer.parentTopicId
  }
  return null
}

/**
 * 分支图入口（导航栏）：打开当前根话题的"统一对话树"。
 * 树由内核各分支会话合并而来（共享上文只出现一次），点击任意节点 = 切到该分支。
 *
 * 血缘单源（统一架构第 1 步）：根在打开抽屉那一刻从内核解析并快照，
 * 打开期间切任意节点都不改变图所挂的家族根 —— 本地 Topic 行血缘缺链/陈旧不再导致"重根"，
 * 也就不会再出现"切右子树后左侧祖先整片消失"。
 */
const BranchGraphButton: React.FC<Props> = ({ assistant, topic, onSwitchTopic }) => {
  const [open, setOpen] = useState(false)
  const [openedRoot, setOpenedRoot] = useState<{ id: string; name?: string } | null>(null)
  // 每次打开抽屉自增：折进 refreshKey 强制家族缓存失效——分支图绝不渲染上一次打开时的陈旧家族
  const [openSeq, setOpenSeq] = useState(0)
  const dispatch = useAppDispatch()
  const activeAssistantId = assistant?.id ?? topic?.assistantId ?? ''
  // kind/签名/物化查找全部用**跨助手联合**（selectAllTopics）：分支图的结构域是内核家族
  // 本身，行分属哪个助手与结构无关。此前按"激活助手"那份清单取 branchKind——同一家族
  // 的行分属不同助手时读到 kind=undefined，regenerate 合并失效、分支被当新问题建节点，
  // 与页码条（归属口径）结构对不上（真机实证的"有时和分支图不对应"）。
  const allRows = useAppSelector(selectAllTopics)
  const storeTopicId = useAppSelector((state) => state.messages.currentTopicId)
  const currentTopic = useMemo(() => {
    if (topic) return topic
    if (storeTopicId) {
      const found = allRows.find((candidate) => candidate.id === storeTopicId)
      if (found) return found
    }
    return listRootTopics(allRows)[0] ?? allRows[0]
  }, [topic, storeTopicId, allRows])
  // 仅作兜底：内核解析失败时退回本地行推断的根（打开时快照一次，不做结构权威）
  const localRoot = useMemo(
    () => (currentTopic ? rootTopicOf(currentTopic, allRows) : undefined),
    [currentTopic, allRows]
  )
  // 家族域签名（与页码条/旁答条同口径）：只盖本家族的行、含 branchKind；
  // 另一边持有者（归属助手）改行也要失效图的家族缓存
  const familyRefreshKey = useMemo(
    () => (currentTopic ? familyRowSignature(allRows, currentTopic.id) : ''),
    [allRows, currentTopic]
  )
  const branchKinds = useMemo(() => branchKindsOf(allRows), [allRows])

  const graphRoot = useMemo(
    () => openedRoot ?? (localRoot ? { id: localRoot.id, name: localRoot.name } : undefined),
    [openedRoot, localRoot]
  )

  const handleOpen = async (): Promise<void> => {
    const startId = currentTopic?.id
    setOpenSeq((seq) => seq + 1)
    if (startId) {
      const kernelRoot = await kernelRootOf(startId)
      if (kernelRoot) {
        setOpenedRoot(kernelRoot)
        setOpen(true)
        return
      }
    }
    if (localRoot) setOpenedRoot({ id: localRoot.id, name: localRoot.name })
    setOpen(true)
  }

  const handleOpenBranch = useMemo(
    () => async (sessionId: string, name?: string) => {
      if (!graphRoot) {
        logger.error('[BranchGraph] node clicked but graphRoot unresolved', { sessionId })
        return
      }
      const materialized = await materializeKernelTopicRow({
        sessionId,
        // 新行落点：激活助手；已有行（含其他助手持有的）由 allRows 联合查找命中——
        // 绝不再往激活助手里造 kindless 重复行（跨助手点击的旧病根）
        assistantId: activeAssistantId,
        allTopics: allRows,
        fallbackParentId: graphRoot.id,
        fallbackName: name ?? graphRoot.name
      })
      if (!materialized) {
        // 绝不静默：图上看得见的节点点击后物化失败，多半是陈旧家族缓存（内核里会话已不存在）
        logger.error('[BranchGraph] materialize failed for visible node', { sessionId, graphRoot: graphRoot.id })
        antdMessage.error(t('chat.branches.jumpFailed'))
        return
      }
      if (materialized.created) {
        dispatch(addTopic({ assistantId: activeAssistantId, topic: materialized.row }))
      }
      requestTopicSwitch(materialized.row)
      onSwitchTopic?.(materialized.row)
    },
    [graphRoot, allRows, activeAssistantId, dispatch, onSwitchTopic]
  )

  return (
    <>
      <Tooltip title={t('chat.history.title')} mouseEnterDelay={0.8}>
        <NavbarIcon onClick={() => void handleOpen()}>
          <HistoryOutlined />
        </NavbarIcon>
      </Tooltip>
      <Drawer
        title={graphRoot?.name ?? t('chat.history.title')}
        placement="right"
        open={open}
        onClose={() => setOpen(false)}
        width={860}
        destroyOnHidden
        styles={{ header: { border: 'none' }, body: { padding: 0, height: 'calc(100% - 55px)' } }}>
        <Body>
          {graphRoot ? (
            <BranchGraph
              rootTopicId={graphRoot.id}
              activeTopicId={currentTopic?.id}
              branchKinds={branchKinds}
              refreshKey={familyRefreshKey + '|' + openSeq}
              onOpenBranch={(sessionId, branchName) => void handleOpenBranch(sessionId, branchName)}
            />
          ) : null}
        </Body>
      </Drawer>
    </>
  )
}

const Body = styled.div`
  width: 100%;
  height: 100%;
  padding: 6px;
`

export default BranchGraphButton
