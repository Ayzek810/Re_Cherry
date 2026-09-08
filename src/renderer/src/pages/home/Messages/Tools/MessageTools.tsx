import type { ToolMessageBlock } from '@renderer/types/newMessage'

import MessageTool from './MessageTool'

interface Props {
  block: ToolMessageBlock
}

export default function MessageTools({ block }: Props) {
  const toolResponse = block.metadata?.rawMcpToolResponse
  if (!toolResponse) return null

  return <MessageTool block={block} />
}
