import { HStack } from '@renderer/components/Layout'
import type { Assistant } from '@renderer/types'
import type { WorkModeApprovalTier } from '@shared/config/workMode'
import { Input } from 'antd'
import { CheckCircle, FolderOpen, ShieldAlert } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingsContainer, SettingsItem, SettingsTitle } from '../shared'
import { mergeWorkMode, WORK_MODE_TIER_I18N, WORK_MODE_TIER_ORDER } from './workModeTiers'

interface Props {
  assistant: Assistant
  updateAssistant: (update: Partial<Omit<Assistant, 'id'>>) => void
}

const FULL_ACCESS_COLOR = '#ff7a45'

/** 绝对路径判定（Windows 盘符 / POSIX 根）。 */
export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')
}

/** 权限模式页：工作模式审批三档（dsh 权限预设，见 @shared/config/workMode）+ 工作目录。 */
const PermissionModeSettings: FC<Props> = ({ assistant, updateAssistant }) => {
  const { t } = useTranslation()
  const selectedTier = assistant.workMode?.approval ?? 'read-only'
  const [workingDir, setWorkingDir] = useState(assistant.workMode?.workingDir ?? '')

  const handleSelectTier = (tier: WorkModeApprovalTier) => {
    if (tier === selectedTier) return
    updateAssistant({ workMode: mergeWorkMode(assistant, { approval: tier }) })
  }

  const handleWorkingDirBlur = () => {
    const next = workingDir.trim()
    if (next === (assistant.workMode?.workingDir ?? '')) return
    updateAssistant({ workMode: mergeWorkMode(assistant, { workingDir: next === '' ? undefined : next }) })
  }

  const dirInvalid = workingDir.trim().length > 0 && !isAbsolutePath(workingDir.trim())

  return (
    <SettingsContainer>
      <SettingsItem divider={false}>
        <SettingsTitle>{t('settings.agentSettings.permissionMode.title')}</SettingsTitle>
        <div className="mt-2 flex flex-col gap-3">
          {WORK_MODE_TIER_ORDER.map((tier) => {
            const isSelected = tier === selectedTier
            const meta = WORK_MODE_TIER_I18N[tier]
            const showCaution = tier === 'danger-full-access'

            return (
              <div
                key={tier}
                className="flex flex-col gap-2 overflow-hidden rounded-lg border p-4 transition-colors cursor-pointer"
                style={{
                  borderColor: isSelected ? 'var(--color-primary)' : 'var(--color-border)',
                  background: isSelected ? 'var(--color-background-soft)' : 'transparent'
                }}
                onClick={() => handleSelectTier(tier)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="whitespace-normal break-words text-left font-semibold text-sm">
                      {t(meta.title)}
                    </span>
                    <span
                      className="whitespace-normal break-words text-left text-xs"
                      style={{ color: 'var(--color-text-2)' }}>
                      {t(meta.description)}
                    </span>
                  </div>
                  {isSelected && <CheckCircle className="flex-shrink-0" size={20} color="var(--color-primary)" />}
                </div>

                {showCaution && (
                  <div
                    className="flex flex-col gap-2"
                    style={{ background: `color-mix(in srgb, ${FULL_ACCESS_COLOR} 8%, transparent)` }}>
                    <div className="flex items-start gap-2 rounded-md p-2">
                      <ShieldAlert className="flex-shrink-0" size={16} color={FULL_ACCESS_COLOR} />
                      <span className="text-xs" style={{ color: FULL_ACCESS_COLOR }}>
                        {t('settings.agentSettings.permissionMode.fullAccessWarning')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SettingsItem>

      <SettingsItem>
        <SettingsTitle>{t('settings.agentSettings.workDir.label')}</SettingsTitle>
        <HStack alignItems="center" gap={8}>
          <FolderOpen size={16} color="var(--color-text-2)" className="flex-shrink-0" />
          <Input
            placeholder={t('settings.agentSettings.workDir.placeholder')}
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            onBlur={handleWorkingDirBlur}
          />
        </HStack>
        <span
          className="text-xs"
          style={{ color: dirInvalid ? 'var(--color-error)' : 'var(--color-text-3)' }}>
          {dirInvalid
            ? t('settings.agentSettings.workDir.invalid')
            : t('settings.agentSettings.workDir.hint')}
        </span>
      </SettingsItem>
    </SettingsContainer>
  )
}

export default PermissionModeSettings
