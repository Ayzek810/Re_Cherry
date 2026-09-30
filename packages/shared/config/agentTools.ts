/**
 * 智能体工具页注册表（设置页开关列表的驱动数据，两种工具面分开登记）。
 * 内置工具 = 未开启工作模式也可用的模型工具；外置工具 = 工作模式开启时才挂载的文件/命令工具。
 * 两组都随助手开关 map（builtinTools / externalTools，稀疏缺省 = 开）挂载，开关状态随发送参数
 * 进内核（与工作模式同一 freshness 通道）；内核挂载注册表按 id → 挂载单元数据驱动（一个单元
 * 可在插件内展开任意数量的工具，逻辑不认工具名）。新增能力（知识库、MCP 等）在对应列表登记
 * id 并在内核挂载注册表加一行即进设置页。
 */

/**
 * 内置工具 id（= dsh 工具名）。两类挂载条件：
 * - 条件挂载（不进本表设置页）：web_search/knowledge_search/skill/read_document/describe_images/
 *   generate_image/web_fetch/knowledge_read/memory_search 随轮条件由渲染层并入 builtinTools
 *   （见 messageThunk；memory_search 门 = 全局记忆开关 && assistant.enableMemory，v0.4.7）。
 * - 本表项 = 每轮按助手开关挂载（稀疏缺省 = 开）：ask_user_question / ocr_document（ocr 另受
 *   附件门）。
 */
export const BUILTIN_TOOL_IDS = ['ask_user_question', 'ocr_document'] as const

export type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number]

/**
 * 外置工具 id（= topics.ts 工作模式工具面的挂载单元）。
 * v0.4.6 用户裁决：memory / todo / goal 归外置——它们都会在会话之外留下持久状态（memory 写
 * 磁盘助手级 FACT/JOURNAL；todo/goal 写会话日志并驱动 UI 面板/自动续轮），属"模型对会话之外
 * 的状态起作用"，归工作模式信任边界（外置不必然消费沙箱——jobs 是先例）。
 */
export const EXTERNAL_TOOL_IDS = [
  'fs',
  'fsSearch',
  'editor',
  'pwsh',
  'jobs',
  'trash',
  'saveAttachment',
  'memory',
  'todo',
  'goal'
] as const

export type ExternalToolId = (typeof EXTERNAL_TOOL_IDS)[number]
