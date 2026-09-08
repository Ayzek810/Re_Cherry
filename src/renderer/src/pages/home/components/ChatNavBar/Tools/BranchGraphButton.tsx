import { HistoryOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import NavbarIcon from '@renderer/components/NavbarIcon'
import BranchGraph from '@renderer/pages/home/Messages/BranchGraph'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addTopic } from '@renderer/store/assistants'
import type { Assistant, Topic } from '@renderer/types'
import { listRootTopics, materializeKernelTopicRow, requestTopicSwitch, rootTopicOf } from '@renderer/utils/topicBranch'
import { Drawer, Tooltip } from 'antd'
import { t } from 'i18next'
import { useMemo, useState } from 'react'
import styled from 'styled-components'

const logger = loggerService.withContext('BranchGraphButton')

interface Props {
  assistant?: Assistant
  topic?: Topic
  onSwitchTopic?: (topic: Topic) => void
}

/** 沿内核血缘（parentTopicId）找到真正的家族根 —— 不依赖渲染层 Topic 行，行缺链/陈旧不影响。 */
async function kernelRootOf(topicId: string): Promise<{ id: string; name?: string } | null> {
  const seen = new Set<string>()
  let id = topicId
  while (!seen.has(id)) {
    seen.add(id)
    try {
      const { topic: kernelTopic } = (await window.api.dshTopicGet(id)) as {
        topic?: { id: string; name?: string; parentTopicId?: string }
      }
      if (!kernelTopic) return null
      if (!kernelTopic.parentTopicId || kernelTopic.parentTopicId.length === 0) {
        return { id: kernelTopic.id, name: kernelTopic.name }
      }
      id = kernelTopic.parentTopicId
    } catch (error) {
      logger.warn('kernel root walk failed at ' + id, error as Error)
      return null
    }
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
  const dispatch = useAppDispatch()
  const assistants = useAppSelector((state) => state.assistants.assistants)
  const activeAssistantId = assistant?.id ?? topic?.assistantId ?? ''
  const assistantTopics = useMemo(
    () => assistants.find((candidate) => candidate.id === activeAssistantId)?.topics ?? [],
    [assistants, activeAssistantId]
  )
  const storeTopicId = useAppSelector((state) => state.messages.currentTopicId)
  const currentTopic = useMemo(() => {
    if (topic) return topic
    if (storeTopicId) {
      const found = assistantTopics.find((candidate) => candidate.id === storeTopicId)
      if (found) return found
    }
    return listRootTopics(assistantTopics)[0] ?? assistantTopics[0]
  }, [topic, storeTopicId, assistantTopics])
  // 仅作兜底：内核解析失败时退回本地行推断的根（打开时快照一次，不做结构权威）
  const localRoot = useMemo(
    () => (currentTopic ? rootTopicOf(currentTopic, assistantTopics) : undefined),
    [currentTopic, assistantTopics]
  )
  const familyRefreshKey = useMemo(
    () => assistantTopics.map((t) => t.id + ':' + t.updatedAt).join('|'),
    [assistantTopics]
  )
  const branchKinds = useMemo(() => {
    const map: Record<string, string | undefined> = {}
    for (const row of assistantTopics) map[row.id] = row.branchKind
    return map
  }, [assistantTopics])

  const graphRoot = openedRoot ?? (localRoot ? { id: localRoot.id, name: localRoot.name } : undefined)

  const handleOpen = async (): Promise<void> => {
    const startId = currentTopic?.id
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
      if (!graphRoot) return
      const materialized = await materializeKernelTopicRow({
        sessionId,
        assistantId: activeAssistantId,
        allTopics: assistantTopics,
        fallbackParentId: graphRoot.id,
        fallbackName: name ?? graphRoot.name
      })
      if (!materialized) return
      if (materialized.created) {
        dispatch(addTopic({ assistantId: activeAssistantId, topic: materialized.row }))
      }
      requestTopicSwitch(materialized.row)
      onSwitchTopic?.(materialized.row)
    },
    [graphRoot, assistantTopics, activeAssistantId, dispatch, onSwitchTopic]
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
              refreshKey={familyRefreshKey}
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
