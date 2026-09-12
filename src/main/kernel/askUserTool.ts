/**
 * ask_user_question 的 fork 变体：与上游 @deepseek-ai/dsh-tool-ask-user 同名、同参数 schema、同结果格式
 * （tool/result 文本 = JSON.stringify({ answers })，渲染层问答卡按此解析已选答案）。
 * 唯一差异：execute 把 exec.callId 带进 ctx.userQuestions.ask 的请求对象（上游 provider 契约没有该
 * 字段，服务原样透传请求对象；渲染层凭 callId 把问答 UI 挂到对应的工具卡上）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-questions'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. ' +
  'Send one or more questions, each with a stable id that will be echoed in the answer.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'ask_user_question',
      description,
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: 'Questions to ask the user before continuing.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
              question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
              header: {
                type: 'string',
                description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".'
              },
              options: {
                type: 'array',
                description:
                  'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                    description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' }
                  }
                }
              },
              multi_select: {
                type: 'boolean',
                description: 'Whether the user may select more than one option. Defaults to false.'
              }
            }
          }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' }
                }
              }
            }
          }
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
      },
      async execute(args, exec) {
        const result = await ctx.userQuestions.ask({
          questions: args.questions.map((question) => ({
            id: question.id,
            question: question.question,
            ...(question.header !== undefined ? { header: question.header } : {}),
            ...(question.options !== undefined ? { options: question.options } : {}),
            ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {})
          })),
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec.signal,
          // fork 扩展（上游契约外字段，服务原样透传给 provider）：渲染层按 callId 配对工具卡
          callId: String(exec.callId)
        } as Parameters<typeof ctx.userQuestions.ask>[0])
        return {
          answers: result.answers.map((answer) => ({
            id: answer.id,
            selected: [...answer.selected],
            ...(answer.custom !== undefined ? { custom: answer.custom } : {})
          }))
        }
      }
    })
  )
}
