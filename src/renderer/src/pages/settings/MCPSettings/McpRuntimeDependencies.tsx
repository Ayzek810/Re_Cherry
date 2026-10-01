import { CheckCircleOutlined, QuestionCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { Center, VStack } from '@renderer/components/Layout'
import { MCP_RUNTIME_COMMANDS, type McpRuntimeCommand, probeMcpRuntimeCommands } from '@renderer/services/mcpApi'
import { Alert, Button } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import styled from 'styled-components'

import { SettingDescription, SettingRow, SettingSubtitle } from '..'

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
  const [commandPaths, setCommandPaths] = useState<Record<McpRuntimeCommand, string | null> | null>(null)

  const refresh = useCallback(async () => {
    const paths = await probeMcpRuntimeCommands()
    setCommandPaths(paths)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const paths = await probeMcpRuntimeCommands()
      if (!cancelled) setCommandPaths(paths)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const checking = commandPaths === null
  const readyCount = commandPaths === null ? 0 : MCP_RUNTIME_COMMANDS.filter((c) => commandPaths[c] !== null).length
  const allReady = readyCount === MCP_RUNTIME_COMMANDS.length

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
        icon={checking ? undefined : allReady ? <CheckCircleOutlined /> : <WarningOutlined />}
        className="nodrag"
        color={checking ? 'default' : allReady ? 'green' : 'danger'}
        onClick={() => navigate('/settings/mcp/mcp-install')}
      />
    )
  }

  return (
    <Container>
      {MCP_RUNTIME_COMMANDS.map((command) => {
        const path = commandPaths?.[command] ?? null
        const found = path !== null
        return (
          <Alert
            key={command}
            type={checking ? 'info' : found ? 'success' : 'warning'}
            style={{ borderRadius: 'var(--list-item-border-radius)' }}
            description={
              <VStack>
                <SettingRow style={{ width: '100%' }}>
                  <SettingSubtitle style={{ margin: 0, fontWeight: 'normal' }}>
                    {checking
                      ? t('settings.mcp.runtimeChecking', { command })
                      : found
                        ? t('settings.mcp.runtimeCommandReady', { command })
                        : t('settings.mcp.runtimeCommandMissing', { command })}
                  </SettingSubtitle>
                </SettingRow>
                {found && (
                  <SettingRow style={{ width: '100%' }}>
                    <SettingDescription style={{ margin: 0, fontWeight: 'normal' }}>{path}</SettingDescription>
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
