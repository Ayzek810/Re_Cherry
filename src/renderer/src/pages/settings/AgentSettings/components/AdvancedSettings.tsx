import { Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingsContainer } from '../shared'

/** 高级页：本版仅保留入口（轮次上限/环境变量等待后续版本裁决）。 */
const AdvancedSettings: FC = () => {
  const { t } = useTranslation()

  return (
    <SettingsContainer>
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-(--color-text-3)">
        <Settings2 size={32} strokeWidth={1.5} />
        <span className="text-sm">{t('settings.agentSettings.advance.empty')}</span>
      </div>
    </SettingsContainer>
  )
}

export default AdvancedSettings
