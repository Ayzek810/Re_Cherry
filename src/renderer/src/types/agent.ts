import * as z from 'zod'

export type AgentType = 'claude-code'

export type AgentServerError = {
  error: {
    message: string
    type: string
    code: string
  }
}

export const AgentServerErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string()
  })
})
