import { UploadOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { nanoid } from '@reduxjs/toolkit'
import CodeEditor from '@renderer/components/CodeEditor'
import { useTimer } from '@renderer/hooks/useTimer'
import { mcpApi } from '@renderer/services/mcpApi'
import { useAppDispatch } from '@renderer/store'
import { setMCPServerActive as setMCPServerActiveById } from '@renderer/store/mcp'
import type { MCPServer } from '@renderer/types'
import { objectKeys, safeValidateMcpConfig } from '@renderer/types'
import { parseJSON } from '@renderer/utils'
import { formatZodError } from '@renderer/utils/error'
import { Button, Form, Modal, Upload } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 自 CS_V1 移植（UI）。fork 改动点：
 * - DXT 导入 接线：uploadDxt 走 Mcp_UploadDxt → 主进程 DxtService 解包校验；
 *   manifest → MCPServer 转换与 ${__dirname}/user_config 参数清洗同上游 AddMcpServerModal
 *   （启动期主进程还会按 dxtPath 重解配置，见 MCPService.initTransport）；
 * - 导入成功后经 checkConnectivity 后台探测连通性并回写 isActive（替身期移除，
 *   随本批次恢复；探测失败不弹错——DXT 服务器可能需额外配置，结果只是启用状态信号）；
 * - 重名检查同时比对 manifest.name 与最终落库名 display_name||name（上游只查前者，
 *   display_name 存在时漏判重名）。
 */
const logger = loggerService.withContext('AddMcpServerModal')

interface AddMcpServerModalProps {
  visible: boolean
  onClose: () => void
  onSuccess: (server: MCPServer) => void
  existingServers: MCPServer[]
  initialImportMethod?: 'json' | 'dxt'
}

interface ParsedServerData extends MCPServer {
  url?: string // JSON 可能包含此欄位，而不是 baseUrl
}

// 預設的 JSON 範例內容
const initialJsonExample = `// Example JSON (stdio):
// {
//   "mcpServers": {
//     "stdio-server-example": {
//       "command": "npx",
//       "args": ["-y", "mcp-server-example"]
//     }
//   }
// }

// Example JSON (sse):
// {
//   "mcpServers": {
//     "sse-server-example": {
//       "type": "sse",
//       "url": "http://localhost:3000"
//     }
//   }
// }

// Example JSON (streamableHttp):
// {
//   "mcpServers": {
//     "streamable-http-example": {
//       "type": "streamableHttp",
//       "url": "http://localhost:3001",
//       "headers": {
//         "Content-Type": "application/json",
//         "Authorization": "Bearer your-token"
//       }
//     }
//   }
// }
`

const AddMcpServerModal: FC<AddMcpServerModalProps> = ({
  visible,
  onClose,
  onSuccess,
  existingServers,
  initialImportMethod = 'json'
}) => {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const dispatch = useAppDispatch()
  const { setTimeoutTimer } = useTimer()
  const [loading, setLoading] = useState(false)
  const [importMethod, setImportMethod] = useState<'json' | 'dxt'>(initialImportMethod)
  const [dxtFile, setDxtFile] = useState<File | null>(null)

  // Update import method when initialImportMethod changes
  useEffect(() => {
    setImportMethod(initialImportMethod)
  }, [initialImportMethod])

  /**
   * 从JSON字符串中解析MCP服务器配置
   * @param inputValue - JSON格式的服务器配置字符串
   * @returns 包含解析后的服务器配置和可能的错误信息的对象
   * - serverToAdd: 解析成功时返回服务器配置对象，失败时返回null
   * - error: 解析失败时返回错误信息，成功时返回null
   */
  const getServerFromJson = (
    inputValue: string
  ): { serverToAdd: Partial<ParsedServerData>; error: null } | { serverToAdd: null; error: string } => {
    const trimmedInput = inputValue.trim()
    const parsedJson = parseJSON(trimmedInput)
    if (parsedJson === null) {
      logger.error('Failed to parse json.', { input: trimmedInput })
      return { serverToAdd: null, error: t('settings.mcp.addServer.importFrom.invalid') }
    }

    const { data: validConfig, error } = safeValidateMcpConfig(parsedJson)
    if (error) {
      logger.error('Failed to validate json.', { parsedJson, error })
      return { serverToAdd: null, error: formatZodError(error, t('settings.mcp.addServer.importFrom.invalid')) }
    }

    let serverToAdd: Partial<ParsedServerData> | null = null

    if (objectKeys(validConfig.mcpServers).length > 1) {
      return { serverToAdd: null, error: t('settings.mcp.addServer.importFrom.error.multipleServers') }
    }

    if (objectKeys(validConfig.mcpServers).length > 0) {
      const key = objectKeys(validConfig.mcpServers)[0]
      serverToAdd = validConfig.mcpServers[key]
      if (!serverToAdd.name) {
        serverToAdd.name = key
      }
    } else {
      return { serverToAdd: null, error: t('settings.mcp.addServer.importFrom.invalid') }
    }

    // zod 太好用了你们知道吗
    return { serverToAdd, error: null }
  }

  const handleOk = async () => {
    try {
      setLoading(true)

      if (importMethod === 'dxt') {
        if (!dxtFile) {
          window.toast.error(t('settings.mcp.addServer.importFrom.noDxtFile'))
          setLoading(false)
          return
        }

        // Process DXT file
        try {
          const installTimestamp = Date.now()
          const result = await mcpApi.uploadDxt(dxtFile)

          if (!result.success || !result.data) {
            window.toast.error(result.error || t('settings.mcp.addServer.importFrom.dxtProcessFailed'))
            setLoading(false)
            return
          }

          const { manifest, extractDir } = result.data

          // Check for duplicate names（同时比对落库名与 manifest.name，见头注释）
          const serverName = manifest.display_name || manifest.name
          if (
            existingServers &&
            existingServers.some((server) => server.name === serverName || server.name === manifest.name)
          ) {
            window.toast.error(t('settings.mcp.addServer.importFrom.nameExists', { name: serverName }))
            setLoading(false)
            return
          }

          // Process args with variable substitution
          const processedArgs = manifest.server.mcp_config.args
            .map((arg) => {
              // Replace ${__dirname} with the extraction directory
              let processedArg = arg.replace(/\$\{__dirname\}/g, extractDir)

              // For now, remove user_config variables and their values
              processedArg = processedArg.replace(/--[^=]*=\$\{user_config\.[^}]+\}/g, '')

              return processedArg.trim()
            })
            .filter((arg) => arg.trim() !== '' && arg !== '--' && arg !== '=' && !arg.startsWith('--='))

          logger.debug('Processed DXT args:', processedArgs)

          // Create MCPServer from DXT manifest
          const newServer: MCPServer = {
            id: nanoid(),
            name: serverName,
            description: manifest.description || manifest.long_description || '',
            baseUrl: '',
            command: manifest.server.mcp_config.command,
            args: processedArgs,
            env: manifest.server.mcp_config.env || {},
            isActive: false,
            type: 'stdio',
            // DXT 元数据：启动期主进程按 dxtPath 重解配置（平台覆写 + 变量替换）
            dxtVersion: manifest.dxt_version,
            dxtPath: extractDir,
            logoUrl: manifest.icon ? `${extractDir}/${manifest.icon}` : undefined,
            provider: manifest.author?.name,
            providerUrl: manifest.homepage || manifest.repository?.url,
            tags: manifest.keywords,
            installSource: 'manual',
            isTrusted: true,
            installedAt: installTimestamp,
            trustedAt: installTimestamp
          }

          onSuccess(newServer)
          form.resetFields()
          setDxtFile(null)
          onClose()

          // Check server connectivity in background (with timeout)；失败只记日志不弹错
          //（DXT 服务器可能需要额外配置，探测结果仅作启用状态信号，上游同语义）
          setTimeoutTimer(
            'handleOkDxtConnectivity',
            () => {
              mcpApi
                .checkConnectivity(newServer)
                .then((isConnected) => {
                  logger.debug(`Connectivity check for ${newServer.name}: ${isConnected}`)
                  // 按 id 窄更新，不再用导入瞬间的 `newServer` 快照整行覆盖。
                  // `checkConnectivity` 走 initClient + listTools，超时下限 180s——用户在这段时间里
                  // 填好的 env / args / apiKey 会被旧快照静默回退（注释自己承认「失败是预期情况」，
                  // 即这条路径经常走到）。切片已有按 id 的 `setMCPServerActive`。
                  dispatch(setMCPServerActiveById({ id: newServer.id, isActive: isConnected }))
                })
                .catch((connError: unknown) => {
                  logger.warn(
                    `DXT server ${newServer.name} connectivity check failed, servers requiring additional setup are expected to fail here`,
                    connError as Error
                  )
                })
            },
            1000
          )
        } catch (error) {
          logger.error('DXT processing error:', error as Error)
          window.toast.error(t('settings.mcp.addServer.importFrom.dxtProcessFailed'))
          setLoading(false)
          return
        }
      } else {
        // Original JSON import logic
        const values = await form.validateFields()
        const inputValue = values.serverConfig.trim()

        const { serverToAdd, error } = getServerFromJson(inputValue)

        if (error !== null) {
          form.setFields([
            {
              name: 'serverConfig',
              errors: [error]
            }
          ])
          setLoading(false)
          return
        }

        // 檢查重複名稱
        if (existingServers && existingServers.some((server) => server.name === serverToAdd.name)) {
          form.setFields([
            {
              name: 'serverConfig',
              errors: [t('settings.mcp.addServer.importFrom.nameExists', { name: serverToAdd.name })]
            }
          ])
          setLoading(false)
          return
        }

        // 如果成功解析並通過所有檢查，立即加入伺服器（非啟用狀態）並關閉對話框
        const installTimestamp = Date.now()
        const newServer: MCPServer = {
          id: nanoid(),
          ...serverToAdd,
          name: serverToAdd.name || t('settings.mcp.newServer'),
          baseUrl: serverToAdd.baseUrl ?? serverToAdd.url ?? '',
          isActive: false, // 初始狀態為非啟用
          installSource: 'manual',
          isTrusted: true,
          installedAt: installTimestamp,
          trustedAt: installTimestamp
        }

        onSuccess(newServer)
        form.resetFields()
        onClose()
      }
    } finally {
      setLoading(false)
    }
  }

  // CodeEditor 內容變更時的回呼函式
  const handleEditorChange = useCallback(
    (newContent: string) => {
      form.setFieldsValue({ serverConfig: newContent })
      // 可選：如果希望即時驗證，可以取消註解下一行
      // form.validateFields(['serverConfig']);
    },
    [form]
  )

  const serverConfigValue = form.getFieldValue('serverConfig')

  return (
    <Modal
      title={
        importMethod === 'dxt'
          ? t('settings.mcp.addServer.importFrom.dxt')
          : t('settings.mcp.addServer.importFrom.json')
      }
      open={visible}
      onOk={handleOk}
      onCancel={() => {
        form.resetFields()
        setDxtFile(null)
        setImportMethod(initialImportMethod)
        onClose()
      }}
      confirmLoading={loading}
      destroyOnHidden
      centered
      transitionName="animation-move-down"
      width={600}>
      <Form form={form} layout="vertical" name="add_mcp_server_form">
        {importMethod === 'json' ? (
          <Form.Item
            name="serverConfig"
            label={t('settings.mcp.addServer.importFrom.tooltip')}
            rules={[{ required: true, message: t('settings.mcp.addServer.importFrom.placeholder') }]}>
            <CodeEditor
              // 如果表單值為空，顯示範例 JSON；否則顯示表單值
              value={serverConfigValue}
              placeholder={initialJsonExample}
              language="json"
              onChange={handleEditorChange}
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
          </Form.Item>
        ) : (
          <Form.Item
            label={t('settings.mcp.addServer.importFrom.dxtFile')}
            help={t('settings.mcp.addServer.importFrom.dxtHelp')}>
            <Upload
              accept=".dxt"
              maxCount={1}
              beforeUpload={(file) => {
                setDxtFile(file)
                return false // Prevent automatic upload
              }}
              onRemove={() => setDxtFile(null)}
              fileList={dxtFile ? [{ uid: '-1', name: dxtFile.name, status: 'done' } as any] : []}>
              <Button icon={<UploadOutlined />}>{t('settings.mcp.addServer.importFrom.selectDxtFile')}</Button>
            </Upload>
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}

export default AddMcpServerModal
