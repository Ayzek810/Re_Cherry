export type ClaudeCodeRawValue = {
  type: string
  session_id?: string
  slash_commands?: string[]
  tools?: string[]
  raw?: unknown
  [key: string]: unknown
}
