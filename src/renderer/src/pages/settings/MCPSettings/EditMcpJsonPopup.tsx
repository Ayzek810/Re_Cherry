import { loggerService } from '@logger'
import CodeEditor from '@renderer/components/CodeEditor'
import { TopView } from '@renderer/components/TopView'
import { mcpApi } from '@renderer/services/mcpApi'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setMCPServers } from '@renderer/store/mcp'
import type { MCPServer } from '@renderer/types'
import { safeValidateMcpConfig } from '@renderer/types'
import { modalConfirm, parseJSON } from '@renderer/utils'
import { formatErrorMessage, formatZodError } from '@renderer/utils/error'
import { Modal, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  resolve: (data: any) => void
}

const logger = loggerService.withContext('EditMcpJsonPopup')

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const [jsonConfig, setJsonConfig] = useState('')
  const [jsonSaving, setJsonSaving] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const mcpServers = useAppSelector((state) => state.mcp.servers)

  const dispatch = useAppDispatch()
  const { t } = useTranslation()

  useEffect(() => {
    setIsLoading(true)
    try {
      const mcpServersObj: Record<string, any> = {}

      mcpServers.forEach((server) => {
        const { id, ...serverData } = server
        mcpServersObj[id] = serverData
      })

      const standardFormat = {
        mcpServers: mcpServersObj
      }

      const formattedJson = JSON.stringify(standardFormat, null, 2)
      setJsonConfig(formattedJson)
      setJsonError('')
    } catch (error) {
      logger.error('Failed to format JSON:', error as Error)
      setJsonError(t('settings.mcp.jsonFormatError'))
    } finally {
      setIsLoading(false)
    }
  }, [mcpServers, t])

  /**
   * 保存 = 用编辑器内容整体替换服务器列表。
   *
   * 修改前：清空编辑器再确定 = **无确认**地删掉所有服务器；且只 `dispatch(setMCPServers(...))`，
   * 绕过了正常删除路径 `mcpApi.removeServer`（主进程关客户端 + DXT 解包目录清理）——
   * 消失的服务器在主进程留下 DXT 目录泄漏，也没有任何「N 成功 / M 失败」汇总。
   */
  const applyServers = async (nextServers: MCPServer[]) => {
    const nextIds = new Set(nextServers.map((server) => server.id))
    const removed = mcpServers.filter((server) => !nextIds.has(server.id))

    if (removed.length > 0) {
      const confirmed = await modalConfirm({
        title: t('settings.mcp.jsonSaveRemoveConfirm.title', { defaultValue: 'Remove MCP servers?' }),
        content: t('settings.mcp.jsonSaveRemoveConfirm.content', {
          count: removed.length,
          defaultValue: 'Saving removes {{count}} server(s) from this list. Continue?'
        })
      })
      if (!confirmed) return
    }

    const failed: string[] = []
    for (const server of removed) {
      try {
        await mcpApi.removeServer(server)
      } catch (error) {
        logger.error(`Failed to remove MCP server ${server.id}`, error as Error)
        failed.push(server.name || server.id)
      }
    }

    dispatch(setMCPServers(nextServers))

    if (failed.length === 0) {
      window.toast.success(t('settings.mcp.jsonSaveSuccess'))
    } else {
      window.toast.warning(
        t('settings.mcp.jsonSavePartial', {
          count: nextServers.length,
          failed: failed.length,
          defaultValue: '{{count}} server(s) saved, {{failed}} failed to remove'
        })
      )
    }
    setJsonError('')
    setOpen(false)
  }

  const onOk = async () => {
    setJsonSaving(true)

    try {
      if (!jsonConfig.trim()) {
        await applyServers([])
        return
      }

      const parsedJson = parseJSON(jsonConfig)
      // 比较的是「导入的函数」而非解析结果，恒为 false —— 语法错误会带着
      // `null` 进入 zod 校验，用户看到的是 "expected object, received null" 而不是本意的导入格式无效。
      if (parsedJson === null) {
        throw new Error(t('settings.mcp.addServer.importFrom.invalid'))
      }

      const { data: parsedServers, error } = safeValidateMcpConfig(parsedJson)
      if (error) {
        throw new Error(formatZodError(error, t('settings.mcp.addServer.importFrom.invalid')))
      }

      const serversArray: MCPServer[] = []

      for (const [id, serverConfig] of Object.entries(parsedServers.mcpServers)) {
        const server: MCPServer = {
          id,
          isActive: false,
          name: serverConfig.name || id,
          ...serverConfig
        }

        serversArray.push(server)
      }

      await applyServers(serversArray)
    } catch (error: unknown) {
      setJsonError(formatErrorMessage(error) || t('settings.mcp.jsonSaveError'))
      window.toast.error(t('settings.mcp.jsonSaveError'))
    } finally {
      setJsonSaving(false)
    }
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  // 同类：不在渲染期给静态类写属性（严格模式下执行两次；卸载后引用仍指向
  // 旧闭包）。关闭路径由 show() 内的 TopView.hide 与 `static hide()` 覆盖。

  return (
    <Modal
      title={t('settings.mcp.editJson')}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      maskClosable={false}
      width={800}
      loading={jsonSaving}
      transitionName="animation-move-down"
      centered>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Text style={{ width: '100%' }} type="danger">
          {jsonError ? <pre>{jsonError}</pre> : ''}
        </Typography.Text>
      </div>
      {isLoading ? (
        <Spin size="large" />
      ) : (
        <CodeEditor
          value={jsonConfig}
          language="json"
          onChange={(value) => setJsonConfig(value)}
          height="60vh"
          expanded={false}
          wrapped
          options={{
            lint: true,
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            keymap: true
          }}
        />
      )}
      <Typography.Text type="secondary">{t('settings.mcp.jsonModeHint')}</Typography.Text>
    </Modal>
  )
}

const TopViewKey = 'EditMcpJsonPopup'

export default class EditMcpJsonPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
