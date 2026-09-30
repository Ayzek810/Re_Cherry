/**
 * 用量统计面板（v0.4.7）：回合级 usage 的本地聚合视图（usage_records 表 →
 * services/usageStats 纯聚合）。范围预设 + 总量卡 + 按日条形 + 按模型分布。
 * 数据只进不出（本地分析），无网络无上报。
 */
import type { UsageSummary } from '@renderer/services/usageStats'
import { usageRangeForPreset } from '@renderer/services/usageStats'
import { queryUsage } from '@renderer/services/usageStore'
import { useAppSelector } from '@renderer/store'
import { BarChart3 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '../index'

type RangePreset = 'today' | '7d' | '30d' | 'all'

const RANGE_PRESETS: RangePreset[] = ['today', '7d', '30d', 'all']

const UsageSettings: FC = () => {
  const { t } = useTranslation()
  const theme = useAppSelector((state) => state.settings.theme)
  const [preset, setPreset] = useState<RangePreset>('7d')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const range = usageRangeForPreset(preset)
    const result = await queryUsage(range)
    setSummary(result)
    setLoading(false)
  }, [preset])

  useEffect(() => {
    void load()
  }, [load])

  const maxDayTokens = Math.max(1, ...(summary?.days ?? []).map((day) => day.inputTokens + day.outputTokens))

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingRow>
          <SettingRowTitle>
            <BarChart3 size={16} style={{ marginRight: 6 }} />
            <SettingTitle>{t('settings.usage.title')}</SettingTitle>
          </SettingRowTitle>
          <div className="flex gap-1">
            {RANGE_PRESETS.map((presetOption) => (
              <button
                key={presetOption}
                type="button"
                onClick={() => setPreset(presetOption)}
                className={
                  'rounded-md px-2.5 py-1 text-xs transition-colors ' +
                  (preset === presetOption
                    ? 'bg-primary text-white'
                    : 'bg-muted text-muted-foreground hover:bg-accent') +
                  ' focus-visible:outline-none'
                }>
                {t(`settings.usage.range.${presetOption}`)}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label={t('settings.usage.requests')} value={summary?.requests ?? 0} loading={loading} />
          <SummaryCard label={t('settings.usage.input_tokens')} value={summary?.inputTokens ?? 0} loading={loading} />
          <SummaryCard label={t('settings.usage.output_tokens')} value={summary?.outputTokens ?? 0} loading={loading} />
        </div>
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.usage.daily')}</SettingTitle>
        {(summary?.days ?? []).length === 0 ? (
          <p className="text-foreground-tertiary mt-3 text-center text-xs">{t('settings.usage.empty')}</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {(summary?.days ?? []).map((day) => {
              const total = day.inputTokens + day.outputTokens
              const width = Math.round((total / maxDayTokens) * 100)
              return (
                <div key={day.date} className="flex items-center gap-2">
                  <span className="text-foreground-tertiary w-24 shrink-0 font-mono text-xs">{day.date}</span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(width, 2)}%` }} />
                  </div>
                  <span className="text-foreground-tertiary w-20 shrink-0 text-right font-mono text-xs">
                    {total.toLocaleString()}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </SettingGroup>

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.usage.by_model')}</SettingTitle>
        {(summary?.byModel ?? []).length === 0 ? (
          <p className="text-foreground-tertiary mt-3 text-center text-xs">{t('settings.usage.empty')}</p>
        ) : (
          <div className="mt-3 flex flex-col gap-1.5">
            {(summary?.byModel ?? []).map((model) => (
              <div key={model.modelId} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{model.modelId}</span>
                <span className="text-foreground-tertiary shrink-0 text-xs">
                  {t('settings.usage.requests_count', { count: model.requests })}
                </span>
                <span className="w-36 shrink-0 text-right font-mono text-xs">
                  ↑{model.inputTokens.toLocaleString()} ↓{model.outputTokens.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingGroup>
    </SettingContainer>
  )
}

const SummaryCard: FC<{ label: string; value: number; loading: boolean }> = ({ label, value, loading }) => (
  <div className="rounded-lg border border-border bg-background p-3">
    <p className="text-foreground-tertiary text-xs">{label}</p>
    <p className="mt-1 font-mono text-xl">{loading ? '—' : value.toLocaleString()}</p>
  </div>
)

export default UsageSettings
