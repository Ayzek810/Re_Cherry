import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import CollapsibleSearchBar from '@renderer/components/CollapsibleSearchBar'
import { Sortable, useDndReorder } from '@renderer/components/dnd'
import { EditIcon } from '@renderer/components/Icons'
import Scrollbar from '@renderer/components/Scrollbar'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import { useMCPServerTrust } from '@renderer/hooks/useMCPServerTrust'
import { mcpApi } from '@renderer/services/mcpApi'
import type { MCPServer } from '@renderer/types'
import { formatMcpError } from '@renderer/utils/error'
import { matchKeywordsInString } from '@renderer/utils/match'
import { Button, Dropdown, Empty } from 'antd'
import { Plus } from 'lucide-react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

import { SettingTitle } from '..'
import AddMcpServerModal from './AddMcpServerModal'
import EditMcpJsonPopup from './EditMcpJsonPopup'
import McpRuntimeDependencies from './McpRuntimeDependencies'
import McpServerCard from './McpServerCard'

const logger = loggerService.withContext('McpServersList')

const McpServersList: FC = () => {
  const { mcpServers, addMCPServer, deleteMCPServer, updateMcpServers, updateMCPServer } = useMCPServers()
  const { ensureServerTrusted } = useMCPServerTrust()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [isAddModalVisible, setIsAddModalVisible] = useState(false)
  const [modalType, setModalType] = useState<'json' | 'dxt'>('json')
  const [loadingServerIds, setLoadingServerIds] = useState<Set<string>>(new Set())
  const [serverVersions, setServerVersions] = useState<Record<string, string | null>>({})

  const [searchText, _setSearchText] = useState('')

  const setSearchText = useCallback((text: string) => {
    startTransition(() => {
      _setSearchText(text)
    })
  }, [])

  const filteredMcpServers = useMemo(() => {
    if (!searchText.trim()) return mcpServers

    const keywords = searchText.toLowerCase().split(/\s+/).filter(Boolean)

    return mcpServers.filter((server) => {
      const searchTarget = `${server.name} ${server.description} ${server.tags?.join(' ')}`
      return matchKeywordsInString(keywords, searchTarget)
    })
  }, [mcpServers, searchText])

  const { onSortEnd } = useDndReorder({
    originalList: mcpServers,
    filteredList: filteredMcpServers,
    onUpdate: updateMcpServers,
    itemKey: 'id'
  })

  const scrollRef = useRef<HTMLDivElement>(null)

  // 简单的滚动位置记忆
  useEffect(() => {
    // 恢复滚动位置
    const savedScroll = sessionStorage.getItem('mcp-list-scroll')
    if (savedScroll && scrollRef.current) {
      scrollRef.current.scrollTop = Number(savedScroll)
    }

    // 保存滚动位置
    const handleScroll = () => {
      if (scrollRef.current) {
        sessionStorage.setItem('mcp-list-scroll', String(scrollRef.current.scrollTop))
      }
    }

    const container = scrollRef.current
    container?.addEventListener('scroll', handleScroll)
    return () => container?.removeEventListener('scroll', handleScroll)
  }, [])

  /**
   * 版本探测。
   *
   * 旧实现对每一次 `mcpServers` 身份变化**全体重探**：`store/mcp.ts` 的任一写入（开关、
   * 工具开关、日志回写、DXT 回写）都会换数组身份 → 一次点击 = 1 次即时探测 + N 次全体重探，
   * 一个会话内 O(N²)，每次都是主进程 `initClient` + ping 或真起进程。
   * 现在：按 id 记账「已探测过的活跃服务器」，只在它**变成活跃**时探一次；同 id 并发去重；
   * 卸载后不再写状态。
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const probedActiveIdsRef = useRef<Set<string>>(new Set())
  const inFlightVersionIdsRef = useRef<Set<string>>(new Set())

  const fetchServerVersion = useCallback(async (server: MCPServer) => {
    if (!server.isActive || inFlightVersionIdsRef.current.has(server.id)) return

    inFlightVersionIdsRef.current.add(server.id)
    try {
      const version = await mcpApi.getServerVersion(server)
      if (mountedRef.current) {
        setServerVersions((prev) => ({ ...prev, [server.id]: version }))
      }
    } catch (error) {
      logger.warn(`Failed to get MCP server version: ${server.id}`, error as Error)
      if (mountedRef.current) {
        setServerVersions((prev) => ({ ...prev, [server.id]: null }))
      }
    } finally {
      inFlightVersionIdsRef.current.delete(server.id)
    }
  }, [])

  // 只在「活跃且此前没探过」时探测；已不活跃的 id 从账上清掉，下次重新启用会再探一次。
  useEffect(() => {
    const activeIds = new Set(mcpServers.filter((server) => server.isActive).map((server) => server.id))
    for (const probedId of probedActiveIdsRef.current) {
      if (!activeIds.has(probedId)) {
        probedActiveIdsRef.current.delete(probedId)
      }
    }
    for (const server of mcpServers) {
      if (server.isActive && !probedActiveIdsRef.current.has(server.id)) {
        probedActiveIdsRef.current.add(server.id)
        void fetchServerVersion(server)
      }
    }
  }, [mcpServers, fetchServerVersion])

  const onAddMcpServer = useCallback(async () => {
    const newServer = {
      id: nanoid(),
      name: t('settings.mcp.newServer'),
      description: '',
      baseUrl: '',
      command: '',
      args: [],
      env: {},
      isActive: false
    }
    addMCPServer(newServer)
    navigate(`/settings/mcp/settings/${encodeURIComponent(newServer.id)}`)
    window.toast.success(t('settings.mcp.addSuccess'))
  }, [addMCPServer, navigate, t])

  const onDeleteMcpServer = useCallback(
    (server: MCPServer) => {
      window.modal.confirm({
        title: t('settings.mcp.deleteServer'),
        content: t('settings.mcp.deleteServerConfirm'),
        centered: true,
        onOk: async () => {
          // `onOk` 的 rejection 不会冒泡到外面的 try/catch（antd 内部
          // `setLoading(false, true); return Promise.reject(e)`），删除失败会零用户可见信号。
          try {
            await mcpApi.removeServer(server)
            deleteMCPServer(server.id)
            window.toast.success(t('settings.mcp.deleteSuccess'))
          } catch (error: unknown) {
            logger.error('Failed to delete MCP server', error as Error)
            window.toast.error(
              `${t('settings.mcp.deleteError')}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  )

  const handleAddServerSuccess = useCallback(
    async (server: MCPServer) => {
      addMCPServer(server)
      setIsAddModalVisible(false)
      window.toast.success(t('settings.mcp.addSuccess'))
      // Optionally navigate to the new server's settings page
      // navigate(`/settings/mcp/settings/${encodeURIComponent(server.id)}`)
    },
    [addMCPServer, t]
  )

  const handleToggleActive = async (server: MCPServer, active: boolean) => {
    let serverForUpdate = server
    if (active) {
      const trustedServer = await ensureServerTrusted(server)
      if (!trustedServer) {
        return
      }
      serverForUpdate = trustedServer
    }

    setLoadingServerIds((prev) => new Set(prev).add(serverForUpdate.id))
    const oldActiveState = serverForUpdate.isActive
    logger.silly('toggle activate', { serverId: serverForUpdate.id, active })
    try {
      if (active) {
        // 记账后再探：探测账本让下面的 effect 不会为同一次启用再探一遍。
        probedActiveIdsRef.current.add(serverForUpdate.id)
        await fetchServerVersion({ ...serverForUpdate, isActive: active })
      } else {
        probedActiveIdsRef.current.delete(serverForUpdate.id)
        await mcpApi.stopServer(serverForUpdate)
        setServerVersions((prev) => ({ ...prev, [serverForUpdate.id]: null }))
      }
      updateMCPServer({ ...serverForUpdate, isActive: active })
    } catch (error: any) {
      window.modal.error({
        title: t('settings.mcp.startError'),
        content: formatMcpError(error),
        centered: true
      })
      updateMCPServer({ ...serverForUpdate, isActive: oldActiveState })
    } finally {
      setLoadingServerIds((prev) => {
        const next = new Set(prev)
        next.delete(serverForUpdate.id)
        return next
      })
    }
  }

  const menuItems = useMemo(
    () => [
      {
        key: 'manual',
        label: t('settings.mcp.addServer.create'),
        onClick: () => {
          void onAddMcpServer()
        }
      },
      {
        key: 'json',
        label: t('settings.mcp.addServer.importFrom.json'),
        onClick: () => {
          setModalType('json')
          setIsAddModalVisible(true)
        }
      },
      {
        key: 'dxt',
        label: t('settings.mcp.addServer.importFrom.dxt'),
        onClick: () => {
          setModalType('dxt')
          setIsAddModalVisible(true)
        }
      }
    ],
    [onAddMcpServer, t]
  )

  return (
    <Container ref={scrollRef}>
      <ListHeader>
        <SettingTitle style={{ gap: 6 }}>
          <span>{t('settings.mcp.newServer')}</span>
          <CollapsibleSearchBar
            onSearch={setSearchText}
            placeholder={t('settings.mcp.search.placeholder')}
            tooltip={t('settings.mcp.search.tooltip')}
            style={{ borderRadius: 20 }}
          />
        </SettingTitle>
        <ButtonGroup>
          <McpRuntimeDependencies mini />
          <Button icon={<EditIcon size={14} />} type="default" shape="round" onClick={() => EditMcpJsonPopup.show()}>
            {t('common.edit')}
          </Button>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
            <Button icon={<Plus size={16} />} type="default" shape="round">
              {t('common.add')}
            </Button>
          </Dropdown>
        </ButtonGroup>
      </ListHeader>
      <Sortable
        items={filteredMcpServers}
        itemKey="id"
        onSortEnd={onSortEnd}
        layout="list"
        horizontal={false}
        listStyle={{ display: 'flex', flexDirection: 'column', width: '100%' }}
        itemStyle={{ width: '100%' }}
        gap="12px"
        restrictions={{ scrollableAncestor: true }}
        useDragOverlay
        showGhost
        renderItem={(server) => (
          <McpServerCard
            server={server}
            version={serverVersions[server.id]}
            isLoading={loadingServerIds.has(server.id)}
            onToggle={async (active) => await handleToggleActive(server, active)}
            onDelete={() => onDeleteMcpServer(server)}
            onEdit={() => navigate(`/settings/mcp/settings/${encodeURIComponent(server.id)}`)}
            onOpenUrl={(url) => window.open(url, '_blank')}
          />
        )}
      />
      {(mcpServers.length === 0 || filteredMcpServers.length === 0) && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={mcpServers.length === 0 ? t('settings.mcp.noServers') : t('common.no_results')}
          style={{ marginTop: 20 }}
        />
      )}

      <AddMcpServerModal
        visible={isAddModalVisible}
        onClose={() => setIsAddModalVisible(false)}
        onSuccess={handleAddServerSuccess}
        existingServers={mcpServers} // 傳遞現有的伺服器列表
        initialImportMethod={modalType}
      />
    </Container>
  )
}

const Container = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: calc(100vh - var(--navbar-height));
  overflow: hidden;
  padding: 20px;
  padding-top: 15px;
  gap: 15px;
  overflow-y: auto;
`

const ListHeader = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;

  h2 {
    font-size: 22px;
    margin: 0;
  }
`

const ButtonGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

export default McpServersList
