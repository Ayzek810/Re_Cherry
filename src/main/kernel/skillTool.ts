/**
 * skill 内核 builtin 工具（批次5 skills 接线）。
 *
 * 上游 v1.9.11 生效机制 = Claude Code SDK 的文件系统发现（symlink 到 agent 工作区），
 * fork 无该工作区概念，改为工具形态：助手启用技能（Assistant.enabledSkills ∩ 切片
 * 元数据）随发送参数登记，可用技能的 name/description 索引进 RuntimeContextProjection
 * 快照节（dsh 去重注入，逐轮新鲜）；模型按需以本工具读 SKILL.md 全文——
 * progressive disclosure 同上游 SDK 语义（索引可见、正文按需）。
 *
 * 执行：主进程 SkillService.readSkillContent（按 name/folderName 反查登记 → 磁盘读
 * SKILL.md）。登记缺位 = 本轮未启用该技能，执行侧防线拒答。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loggerService } from '@logger'

import { skillService } from '../services/skills/SkillService'

const logger = loggerService.withContext('SkillTool')

export const name = 'tool-skill'
// execute 里读到的每个 cordis Service 都必须在此声明（get 走 inject 声明制）。
export const inject = ['tools']

const DESCRIPTION =
  'Read the full instructions (SKILL.md) of an attached skill. The list of attached skills — with their ' +
  'names and what they do — appears in the conversation context under "Attached skills". Use this tool ' +
  "when the user's request matches a skill's purpose, passing the skill name exactly as listed. Follow " +
  'the returned instructions to complete the task.'

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'skill',
      description: DESCRIPTION,
      parameters: {
        skill: {
          type: 'string',
          required: true,
          description: 'The skill name exactly as listed in the "Attached skills" context note.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skill: { type: 'string', required: true },
            text: { type: 'string', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const skillName = String(args.skill ?? '').trim()
        if (skillName.length === 0) {
          throw new Error('skill: empty skill name')
        }
        const topicId = exec.agent?.session?.id
        if (topicId === undefined) {
          throw new Error('skill: no active conversation turn')
        }
        const text = await skillService.readSkillContent(topicId, skillName)
        logger.info(`skill: loaded "${skillName}" (${text.length} chars)`)
        return { skill: skillName, text }
      }
    })
  )
}
