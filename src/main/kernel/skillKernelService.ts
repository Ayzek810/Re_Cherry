/**
 * skill 工具每轮登记缝（ctx.skills，批次5 skills 接线；knowledge/webSearch 同先例）。
 *
 * 状态本体在主进程 SkillService（工具执行直读单例，SKILL.md 磁盘真相源新鲜读取），
 * 本缝只承担 cordis 声明制落位与转发。
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { loggerService } from '@logger'

import type { SkillTurnEntry } from '../services/skills/SkillService'
import { skillService } from '../services/skills/SkillService'

const logger = loggerService.withContext('SkillKernel')

export type { SkillTurnEntry }

export class SkillKernelService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  /** 每轮登记（topics.sendMessage 按发送参数写入；undefined = 本轮未启用技能）。 */
  setTurnSkills(topicId: string, skills: SkillTurnEntry[] | undefined): void {
    skillService.setTurnSkills(topicId, skills)
    logger.debug(`skill turn registration updated: ${skills?.length ?? 0} skill(s)`)
  }
}
