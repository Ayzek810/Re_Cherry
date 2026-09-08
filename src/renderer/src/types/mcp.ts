export type McpServerType = 'stdio' | 'sse' | 'streamableHttp' | 'inMemory'

export type MCPServerInstallSource = 'builtin' | 'manual' | 'protocol' | 'unknown'

export type MCPConfigSample = {
  command: string
  args: string[]
  env?: Record<string, string>
}
