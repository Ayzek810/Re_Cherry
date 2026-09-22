/**
 * MCP 工具命名规则（v0.3.2 批次3 自 CS_V1 packages/shared/mcp.ts 移植，纯函数零依赖）。
 *
 * 上游把 MCP 工具暴露给 LLM 时统一用 `mcp__{server}__{tool}` 函数名（camelCase、
 * 63 字符截断、冲突加序号后缀）；fork 的主进程 MCPService（listTools 组装 MCPTool.id）
 * 与内核 MCP 桥（defineTool name）共用本规则，保证两处生成的名字逐字一致。
 */

/**
 * Convert a string to camelCase, ensuring it's a valid JavaScript identifier.
 * - Non-alphanumeric characters are treated as word separators
 * - Non-ASCII characters are dropped (ASCII-only output)
 * - If result starts with a digit, prefixes with underscore
 * @example toCamelCase('my-server') // 'myServer'
 */
export function toCamelCase(str: string): string {
  let result = str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')

  if (result && !/^[a-zA-Z_]/.test(result)) {
    result = '_' + result
  }

  return result
}

function truncateToLength(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, maxLength).replace(/_+$/, '')
}

/**
 * Build a valid JavaScript function name from server and tool names.
 * @param options.maxLength 截断上限（后缀序号计入该上限）
 * @param options.existingNames 冲突检测集合（命中则追加 1/2/3… 序号）
 */
export function buildMcpToolName(
  serverName: string | undefined,
  toolName: string,
  options: { prefix?: string; delimiter?: string; maxLength?: number; existingNames?: Set<string> } = {}
): string {
  const { prefix = '', delimiter = '_', maxLength, existingNames } = options

  const serverPart = serverName ? toCamelCase(serverName) : ''
  const toolPart = toCamelCase(toolName)
  const baseName = serverPart ? `${prefix}${serverPart}${delimiter}${toolPart}` : `${prefix}${toolPart}`

  if (!existingNames) {
    return maxLength ? truncateToLength(baseName, maxLength) : baseName
  }

  let name = maxLength ? truncateToLength(baseName, maxLength) : baseName
  let counter = 1

  while (existingNames.has(name)) {
    const suffix = String(counter)
    const truncatedBase = maxLength ? truncateToLength(baseName, maxLength - suffix.length) : baseName
    name = `${truncatedBase}${suffix}`
    counter++
  }

  existingNames.add(name)
  return name
}

/**
 * LLM 工具面用的 MCP 工具函数名：`mcp__{server}__{tool}`，最长 63 字符。
 * @example buildFunctionCallToolName('github', 'search_issues') // 'mcp__github__searchIssues'
 */
export function buildFunctionCallToolName(serverName: string, toolName: string): string {
  return buildMcpToolName(serverName, toolName, {
    prefix: 'mcp__',
    delimiter: '__',
    maxLength: 63
  })
}
