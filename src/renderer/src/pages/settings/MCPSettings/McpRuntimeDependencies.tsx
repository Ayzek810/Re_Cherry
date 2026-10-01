import { CheckCircleOutlined, QuestionCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { Center, VStack } from '@renderer/components/Layout'
import {
  MCP_RUNTIME_COMMANDS,
  mcpApi,
  type McpRuntimeCommand,
  probeMcpRuntimeCommands
} from '@renderer/services/mcpApi'
import { Alert, Button } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

import { SettingDescription, SettingRow, SettingSubtitle } from '..'

const logger = loggerService.withContext('McpRuntimeDependencies')

/** 三值探测结果：`'unknown'` = 探测本身失败，不可当作「缺失」。 */
type RuntimeCommandProbe = string | null | 'unknown'

interface Props {
  mini?: boolean
}

/**
 * MCP 运行时依赖页（v1 重写，原 InstallNpxUv）。
 *
 * 为什么重写：fork 的 MCP stdio 服务器靠**系统 PATH** 解析 npx/uvx
 * （`main/services/mcp/commandResolution.ts`），并不托管 uv/bun 二进制。旧页面照 V1
 * 用死桩（`isBinaryExist` 恒 false / `getInstallInfo` 恒 null）呈现，**永远显示「依赖缺失」**
 * 且安装键只弹「待接线」——失败伪装 + 孤儿代码。现在改为如实探测两个命令并给出安装指引，
 * 不再提供无法生效的操作。
 */
const McpRuntimeDependencies: FC<Props> = ({ mini = false }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [commandPaths, setCommandPaths] = useState<Record<McpRuntimeCommand, RuntimeCommandProbe> | null>(null)

  /**
   * 探测两个命令。
   *
   * `probeMcpRuntimeCommands` 把「IPC 探测失败」与「命令确实不在 PATH」都折叠成 `null`，
   * 而它的文档注释承诺「不谎报缺失」。UI 不能把不可知状态当结论，
   * 所以这里对返回 `null` 的命令**复核一次**：复核抛错 = 探测失败（unknown），
   * 复核仍是 `null` = 命令确实不在 PATH（missing）。
   */
  const probeRuntimeCommands = useCallback(async () => {
    const paths = await probeMcpRuntimeCommands()
    const probes: Record<McpRuntimeCommand, RuntimeCommandProbe> = { ...paths }
    await Promise.all(
      MCP_RUNTIME_COMMANDS.filter((command) => paths[command] === null).map(async (command) => {
        try {
          probes[command] = (await mcpApi.checkCommand(command)) ?? null
        } catch (error) {
          logger.warn(`MCP runtime command probe failed: ${command}`, error as Error)
          probes[command] = 'unknown'
        }
      })
    )
    return probes
  }, [])

  const refresh = useCallback(async () => {
    const paths = await probeRuntimeCommands()
    setCommandPaths(paths)
  }, [probeRuntimeCommands])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const paths = await probeRuntimeCommands()
      if (!cancelled) setCommandPaths(paths)
    })()
    return () => {
      cancelled = true
    }
  }, [probeRuntimeCommands])

  const checking = commandPaths === null
  const readyCount =
    commandPaths === null
      ? 0
      : MCP_RUNTIME_COMMANDS.filter((c) => commandPaths[c] !== null && commandPaths[c] !== 'unknown').length
  const allReady = readyCount === MCP_RUNTIME_COMMANDS.length
  const hasUnknown = commandPaths !== null && MCP_RUNTIME_COMMANDS.some((c) => commandPaths[c] === 'unknown')

  const onHelp = () => {
    window.open('https://docs.cherry-ai.com/advanced-basic/mcp', '_blank')
  }

  if (mini) {
    return (
      <Button
        type="primary"
        variant="filled"
        shape="circle"
        loading={checking}
        icon={
          checking ? undefined : allReady ? (
            <CheckCircleOutlined />
          ) : hasUnknown ? (
            <QuestionCircleOutlined />
          ) : (
            <WarningOutlined />
          )
        }
        className="nodrag"
        color={checking ? 'default' : allReady ? 'green' : hasUnknown ? 'default' : 'danger'}
        onClick={() => navigate('/settings/mcp/mcp-install')}
      />
    )
  }

  return (
    <Container>
      {MCP_RUNTIME_COMMANDS.map((command) => {
        const probe = commandPaths?.[command]
        const unknown = probe === 'unknown'
        const found = typeof probe === 'string' && !unknown && probe.length > 0
        return (
          <Alert
            key={command}
            type={checking ? 'info' : found ? 'success' : unknown ? 'info' : 'warning'}
            style={{ borderRadius: 'var(--list-item-border-radius)' }}
            description={
              <VStack>
                <SettingRow style={{ width: '100%' }}>
                  <SettingSubtitle style={{ margin: 0, fontWeight: 'normal' }}>
                    {checking
                      ? t('settings.mcp.runtimeChecking', { command })
                      : found
                        ? t('settings.mcp.runtimeCommandReady', { command })
                        : unknown
                          ? t('settings.mcp.runtimeCommandUnknown', {
                              command,
                              defaultValue: 'Cannot probe {{command}} right now'
                            })
                          : t('settings.mcp.runtimeCommandMissing', { command })}
                  </SettingSubtitle>
                </SettingRow>
                {found && (
                  <SettingRow style={{ width: '100%' }}>
                    <SettingDescription style={{ margin: 0, fontWeight: 'normal' }}>{probe}</SettingDescription>
                  </SettingRow>
                )}
              </VStack>
            }
          />
        )
      })}
      <SettingDescription style={{ margin: 0 }}>{t('settings.mcp.runtimeNote')}</SettingDescription>
      <Center>
        <Button type="link" onClick={onHelp} icon={<QuestionCircleOutlined />}>
          {t('settings.mcp.installHelp')}
        </Button>
        <Button type="link" onClick={() => void refresh()} disabled={checking}>
          {t('common.refresh')}
        </Button>
      </Center>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  margin-bottom: 20px;
  gap: 12px;
  padding-top: 50px;
`

export default McpRuntimeDependencies
