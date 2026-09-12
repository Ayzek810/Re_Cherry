/**
 * 智能体工具页注册表（设置页开关列表的驱动数据，两种工具面分开登记）。
 * 内置工具 = 未开启工作模式也可用的模型工具；外置工具 = 工作模式开启时才挂载的文件/命令工具。
 * 两组都随助手开关 map（builtinTools / externalTools，稀疏缺省 = 开）挂载，开关状态随发送参数
 * 进内核（与工作模式同一 freshness 通道）。新增能力（知识库、MCP 等）在对应列表登记 id 即进设置页。
 */

/** 内置工具 id（= dsh 工具名）。 */
export const BUILTIN_TOOL_IDS = ['ask_user_question'] as const

export type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number]

/** 外置工具 id（= topics.ts 工作模式工具面的挂载单元）。 */
export const EXTERNAL_TOOL_IDS = ['fs', 'fsSearch', 'editor', 'pwsh', 'jobs'] as const

export type ExternalToolId = (typeof EXTERNAL_TOOL_IDS)[number]
