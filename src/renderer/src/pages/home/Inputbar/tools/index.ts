// Tool registry loader
// Import all tool definitions to register them

import './attachmentTool'
import './knowledgeBaseTool'
import './mentionModelsTool'
import './mcpToolsTool'
import './newTopicTool'
import './quickPhrasesTool'
import './thinkingTool'
import './urlContextTool'
import './clearTopicTool'
import './toggleExpandTool'
import './slashCommandsTool'
import './webSearchTool'

// Export registry functions
export { getAllTools, getTool, getToolsForScope, registerTool } from '../types'
