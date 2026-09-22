/**
 * v0.3.2 自 CS_V1 移植（MCP 服务器读写 hooks）。
 * fork 改动点：去掉 V1 的两个模块级主进程监听（Mcp_ServersChanged / Mcp_AddServer）——
 * 服务器进程管理与主进程同步属批次3 接线；本切片当前即唯一真相源。
 */
import { createSelector } from '@reduxjs/toolkit'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addMCPServer, deleteMCPServer, setMCPServers, updateMCPServer } from '@renderer/store/mcp'
import type { MCPServer } from '@renderer/types'

const selectMcpServers = (state: { mcp: { servers: MCPServer[] } }) => state.mcp.servers
const selectActiveMcpServers = createSelector([selectMcpServers], (servers) =>
  servers.filter((server) => server.isActive)
)

export const useMCPServers = () => {
  const mcpServers = useAppSelector(selectMcpServers)
  const activedMcpServers = useAppSelector(selectActiveMcpServers)
  const dispatch = useAppDispatch()

  return {
    mcpServers,
    activedMcpServers,
    addMCPServer: (server: MCPServer) => dispatch(addMCPServer(server)),
    updateMCPServer: (server: MCPServer) => dispatch(updateMCPServer(server)),
    deleteMCPServer: (id: string) => dispatch(deleteMCPServer(id)),
    setMCPServerActive: (server: MCPServer, isActive: boolean) => dispatch(updateMCPServer({ ...server, isActive })),
    getActiveMCPServers: () => mcpServers.filter((server) => server.isActive),
    updateMcpServers: (servers: MCPServer[]) => dispatch(setMCPServers(servers))
  }
}

export const useMCPServer = (id: string) => {
  const server = useAppSelector((state) => (state.mcp.servers || []).find((server) => server.id === id))
  const dispatch = useAppDispatch()

  return {
    server,
    updateMCPServer: (server: MCPServer) => dispatch(updateMCPServer(server)),
    setMCPServerActive: (server: MCPServer, isActive: boolean) => dispatch(updateMCPServer({ ...server, isActive })),
    deleteMCPServer: (id: string) => dispatch(deleteMCPServer(id))
  }
}
