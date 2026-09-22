import { useAppSelector } from '@renderer/store'
import type { Assistant } from '@renderer/types'
import { Switch } from 'antd'
import { Puzzle } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingsContainer } from '../shared'

interface SkillsSettingsProps {
  assistant?: Assistant
  updateAssistant?: (assistant: Assistant) => void
}

/**
 * 技能页（v0.3.2 批次1）：按助手启用的技能开关列表（用户裁决）。
 * 数据源为 redux skills 切片（批次5 接线后由本地 skill 目录/市场安装填充）；
 * 开关写 assistant.enabledSkills（仅持久化选择，执行注入随批次5 接线）。
 */
const SkillsSettings: FC<SkillsSettingsProps> = ({ assistant, updateAssistant }) => {
  const { t } = useTranslation()
  const installedSkills = useAppSelector((state) => state.skills.installedSkills)

  if (!assistant || !updateAssistant) {
    return (
      <SettingsContainer>
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-(--color-text-3)">
          <Puzzle size={32} strokeWidth={1.5} />
          <span className="text-sm">{t('settings.agentSettings.skills.empty')}</span>
        </div>
      </SettingsContainer>
    )
  }

  const enabledSkills = assistant.enabledSkills || []

  const handleToggle = (skillId: string) => {
    const next = enabledSkills.includes(skillId)
      ? enabledSkills.filter((id) => id !== skillId)
      : [...enabledSkills, skillId]
    updateAssistant({ ...assistant, enabledSkills: next })
  }

  return (
    <SettingsContainer>
      {installedSkills.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-(--color-text-3)">
          <Puzzle size={32} strokeWidth={1.5} />
          <span className="text-sm">{t('settings.agentSettings.skills.empty')}</span>
        </div>
      ) : (
        <SkillList>
          {installedSkills.map((skill) => {
            const isEnabled = enabledSkills.includes(skill.id)
            return (
              <SkillItem key={skill.id}>
                <SkillInfo>
                  <SkillName>{skill.name}</SkillName>
                  {skill.description && <SkillDescription>{skill.description}</SkillDescription>}
                </SkillInfo>
                <Switch checked={isEnabled} onChange={() => handleToggle(skill.id)} size="small" />
              </SkillItem>
            )
          })}
        </SkillList>
      )}
    </SettingsContainer>
  )
}

const SkillList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
`

const SkillItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  background-color: var(--color-background-mute);
  border: 1px solid var(--color-border);
`

const SkillInfo = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
`

const SkillName = styled.div`
  font-weight: 600;
  margin-bottom: 4px;
`

const SkillDescription = styled.div`
  font-size: 0.85rem;
  color: var(--color-text-2);
`

export default SkillsSettings
