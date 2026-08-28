// Tool registry loader
// Import all tool definitions to register them

import './attachmentTool'
import './mentionModelsTool'
import './newTopicTool'
import './quickPhrasesTool'
import './thinkingTool'
import './urlContextTool'
import './clearTopicTool'
import './toggleExpandTool'
import './newContextTool'
import './slashCommandsTool'

// Export registry functions
export { getAllTools, getTool, getToolsForScope, registerTool } from '../types'
