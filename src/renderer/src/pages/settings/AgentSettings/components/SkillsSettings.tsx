import { Puzzle } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingsContainer } from '../shared'

/** 技能页：本版仅保留入口（技能系统随 v0.3.2 加回）。 */
const SkillsSettings: FC = () => {
  const { t } = useTranslation()

  return (
    <SettingsContainer>
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-(--color-text-3)">
        <Puzzle size={32} strokeWidth={1.5} />
        <span className="text-sm">{t('settings.agentSettings.skills.empty')}</span>
      </div>
    </SettingsContainer>
  )
}

export default SkillsSettings
