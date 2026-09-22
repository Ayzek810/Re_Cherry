/**
 * v0.3.2 自 CS_V1 移植（MCP 模式/服务器 QuickPanel 按钮）。
 * 批次1（UI）改动点：
 * - Prompts/Resources 面板未移植（依赖 window.api.mcp.*，批次3 恢复）；
 * - Gemini/url-context 冲突检查未移植（批次2/3 按内核语义重写）；
 * - 'mcp-server-select' 事件中转改为直接调用（本面板自身即是唯一入口）。
 */
import { ActionIconButton } from '@renderer/components/Buttons'
import type { QuickPanelListItem } from '@renderer/components/QuickPanel'
import { QuickPanelReservedSymbol, useQuickPanel } from '@renderer/components/QuickPanel'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useMCPServers } from '@renderer/hooks/useMCPServers'
import { useTimer } from '@renderer/hooks/useTimer'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { McpMode, MCPServer } from '@renderer/types'
import { getEffectiveMcpMode } from '@renderer/types'
import { Tooltip } from 'antd'
import { CircleX, Hammer, Plus, Sparkles } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

interface Props {
  assistantId: string
  quickPanel: ToolQuickPanelApi
  setInputValue: React.Dispatch<React.SetStateAction<string>>
  resizeTextArea: () => void
}

const MCPToolsButton: FC<Props> = ({ quickPanel, assistantId }) => {
  const { activedMcpServers } = useMCPServers()
  const { t } = useTranslation()
  const quickPanelHook = useQuickPanel()
  const navigate = useNavigate()

  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { setTimeoutTimer } = useTimer()

  const currentMode = useMemo(() => getEffectiveMcpMode(assistant), [assistant])

  const mcpServers = useMemo(() => assistant.mcpServers || [], [assistant.mcpServers])
  const assistantMcpServers = useMemo(
    () => activedMcpServers.filter((server) => mcpServers.some((s) => s.id === server.id)),
    [activedMcpServers, mcpServers]
  )

  const handleModeChange = useCallback(
    (mode: McpMode) => {
      setTimeoutTimer(
        'updateMcpMode',
        () => {
          updateAssistant({
            ...assistant,
            mcpMode: mode
          })
        },
        200
      )
    },
    [assistant, setTimeoutTimer, updateAssistant]
  )

  const handleMcpServerSelect = useCallback(
    (server: MCPServer) => {
      const update = { ...assistant }
      if (assistantMcpServers.some((s) => s.id === server.id)) {
        update.mcpServers = mcpServers.filter((s) => s.id !== server.id)
      } else {
        update.mcpServers = [...mcpServers, server]
      }

      update.mcpMode = 'manual'
      updateAssistant(update)
    },
    [assistant, assistantMcpServers, mcpServers, updateAssistant]
  )

  const manualModeMenuItems = useMemo(() => {
    const newList: QuickPanelListItem[] = activedMcpServers.map((server) => ({
      label: server.name,
      description: server.description || server.baseUrl,
      icon: <Hammer />,
      action: () => handleMcpServerSelect(server),
      isSelected: assistantMcpServers.some((s) => s.id === server.id)
    }))

    newList.push({
      label: t('settings.mcp.addServer.label') + '...',
      icon: <Plus />,
      action: () => navigate('/settings/mcp')
    })

    return newList
  }, [activedMcpServers, t, assistantMcpServers, navigate, handleMcpServerSelect])

  const openManualModePanel = useCallback(() => {
    quickPanelHook.open({
      title: t('assistants.settings.mcp.mode.manual.label'),
      list: manualModeMenuItems,
      symbol: QuickPanelReservedSymbol.Mcp,
      multiple: true,
      afterAction({ item }) {
        item.isSelected = !item.isSelected
      }
    })
  }, [manualModeMenuItems, quickPanelHook, t])

  const menuItems = useMemo(() => {
    const newList: QuickPanelListItem[] = []

    newList.push({
      label: t('assistants.settings.mcp.mode.disabled.label'),
      description: t('assistants.settings.mcp.mode.disabled.description'),
      icon: <CircleX />,
      isSelected: currentMode === 'disabled',
      action: () => {
        handleModeChange('disabled')
        quickPanelHook.close()
      }
    })

    newList.push({
      label: t('assistants.settings.mcp.mode.auto.label'),
      description: t('assistants.settings.mcp.mode.auto.description'),
      icon: <Sparkles />,
      isSelected: currentMode === 'auto',
      action: () => {
        handleModeChange('auto')
        quickPanelHook.close()
      }
    })

    newList.push({
      label: t('assistants.settings.mcp.mode.manual.label'),
      description: t('assistants.settings.mcp.mode.manual.description'),
      icon: <Hammer />,
      isSelected: currentMode === 'manual',
      isMenu: true,
      action: () => {
        handleModeChange('manual')
        openManualModePanel()
      }
    })

    return newList
  }, [t, currentMode, handleModeChange, quickPanelHook, openManualModePanel])

  const openQuickPanel = useCallback(() => {
    quickPanelHook.open({
      title: t('settings.mcp.title'),
      list: menuItems,
      symbol: QuickPanelReservedSymbol.Mcp,
      multiple: false
    })
  }, [menuItems, quickPanelHook, t])

  const handleOpenQuickPanel = useCallback(() => {
    if (quickPanelHook.isVisible && quickPanelHook.symbol === QuickPanelReservedSymbol.Mcp) {
      quickPanelHook.close()
    } else {
      openQuickPanel()
    }
  }, [openQuickPanel, quickPanelHook])

  useEffect(() => {
    const disposeRootMenu = quickPanel.registerRootMenu([
      {
        label: t('settings.mcp.title'),
        description: '',
        icon: <Hammer />,
        isMenu: true,
        action: () => openQuickPanel()
      }
    ])

    const disposeTrigger = quickPanel.registerTrigger(QuickPanelReservedSymbol.Mcp, () => openQuickPanel())

    return () => {
      disposeRootMenu()
      disposeTrigger()
    }
  }, [openQuickPanel, quickPanel, t])

  const isActive = currentMode !== 'disabled'

  const getButtonIcon = () => {
    switch (currentMode) {
      case 'auto':
        return <Sparkles size={18} />
      case 'disabled':
      case 'manual':
      default:
        return <Hammer size={18} />
    }
  }

  return (
    <Tooltip placement="top" title={t('settings.mcp.title')} mouseLeaveDelay={0} arrow>
      <ActionIconButton onClick={handleOpenQuickPanel} active={isActive} aria-label={t('settings.mcp.title')}>
        {getButtonIcon()}
      </ActionIconButton>
    </Tooltip>
  )
}

export default React.memo(MCPToolsButton)
