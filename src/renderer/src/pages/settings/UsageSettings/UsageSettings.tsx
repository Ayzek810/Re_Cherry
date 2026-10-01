/**
 * 用量统计面板：回合级 usage 的本地聚合视图（usage_records 表 →
 * services/usageStats 纯聚合）。范围预设 + 总量卡 + 按日条形 + 按模型分布。
 * 数据只进不出（本地分析），无网络无上报。
 *
 * 失败语义：读取失败必须渲染成显式错误态。修改前 `queryUsage`
 * 失败返回合法空汇总，面板把它画成「0 用量 + 暂无数据」——一张权威报表，用户会据此
 * 认为统计坏了却找不到原因，且数字 0 与真的 0 不可区分。
 */
import type { UsageSummary } from '@renderer/services/usageStats'
import { usageRangeForPreset } from '@renderer/services/usageStats'
import { queryUsage } from '@renderer/services/usageStore'
import { useAppSelector } from '@renderer/store'
import { Alert, Button } from 'antd'
import { BarChart3 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingContainer, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '../index'

type RangePreset = 'today' | '7d' | '30d' | 'all'

const RANGE_PRESETS: RangePreset[] = ['today', '7d', '30d', 'all']

/** 预设 → 文案键。显式映射取代模板键（v1）：联合穷尽由编译器保证，键为字面量走静态键检。 */
const RANGE_LABEL_KEYS: Record<RangePreset, string> = {
  today: 'settings.usage.range.today',
  '7d': 'settings.usage.range.7d',
  '30d': 'settings.usage.range.30d',
  all: 'settings.usage.range.all'
}

const UsageSettings: FC = () => {
  const { t } = useTranslation()
  const theme = useAppSelector((state) => state.settings.theme)
  const [preset, setPreset] = useState<RangePreset>('7d')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  /** 竞态守卫：快速连点范围预设时，慢的旧查询不得覆盖新结果。 */
  const requestIdRef = useRef(0)
  const [failedRequestId, setFailedRequestId] = useState(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadError(null)
    const range = usageRangeForPreset(preset)
    const result = await queryUsage(range)

    if (requestId !== requestIdRef.current) return

    if (result.ok) {
      setSummary(result.summary)
    } else {
      // 失败态：清掉 old summary，避免残留数字被读成当前范围的结果。
      setSummary(null)
      setLoadError(result.error)
      setFailedRequestId(requestId)
    }
    setLoading(false)
  }, [preset])

  useEffect(() => {
    void load()
  }, [load])

  const hasError = loadError !== null
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
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  preset === presetOption ? 'bg-primary text-white' : 'bg-muted text-muted-foreground hover:bg-accent'
                } focus-visible:outline-none`}>
                {t(RANGE_LABEL_KEYS[presetOption])}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>

      {hasError && (
        <SettingGroup theme={theme}>
          <Alert
            type="error"
            showIcon
            message={t('settings.usage.load_failed', { defaultValue: 'Failed to read local usage records' })}
            description={loadError}
            action={
              <Button size="small" key={failedRequestId} onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            }
          />
        </SettingGroup>
      )}

      <SettingGroup theme={theme}>
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard
            label={t('settings.usage.requests')}
            value={summary?.requests}
            loading={loading}
            errored={hasError}
          />
          <SummaryCard
            label={t('settings.usage.input_tokens')}
            value={summary?.inputTokens}
            loading={loading}
            errored={hasError}
          />
          <SummaryCard
            label={t('settings.usage.output_tokens')}
            value={summary?.outputTokens}
            loading={loading}
            errored={hasError}
          />
        </div>
      </SettingGroup>

      {!hasError && (
        <>
          <SettingGroup theme={theme}>
            <SettingTitle>{t('settings.usage.daily')}</SettingTitle>
            {(summary?.days ?? []).length === 0 ? (
              <p className="mt-3 text-center text-foreground-tertiary text-xs">{t('settings.usage.empty')}</p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {(summary?.days ?? []).map((day) => {
                  const total = day.inputTokens + day.outputTokens
                  const width = Math.round((total / maxDayTokens) * 100)
                  return (
                    <div key={day.date} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 font-mono text-foreground-tertiary text-xs">{day.date}</span>
                      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${Math.max(width, 2)}%` }}
                        />
                      </div>
                      <span className="w-20 shrink-0 text-right font-mono text-foreground-tertiary text-xs">
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
              <p className="mt-3 text-center text-foreground-tertiary text-xs">{t('settings.usage.empty')}</p>
            ) : (
              <div className="mt-3 flex flex-col gap-1.5">
                {(summary?.byModel ?? []).map((model) => (
                  <div key={model.modelId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">{model.modelId}</span>
                    <span className="shrink-0 text-foreground-tertiary text-xs">
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
        </>
      )}
    </SettingContainer>
  )
}

/**
 * `value === undefined` / `errored` / `loading` 都渲染「—」而不是数字：
 * 读取失败时不得画出 `0`，那会被读成一个真实结论。
 */
const SummaryCard: FC<{ label: string; value?: number; loading: boolean; errored: boolean }> = ({
  label,
  value,
  loading,
  errored
}) => (
  <div className="rounded-lg border border-border bg-background p-3">
    <p className="text-foreground-tertiary text-xs">{label}</p>
    <p className="mt-1 font-mono text-xl">{loading || errored || value === undefined ? '—' : value.toLocaleString()}</p>
  </div>
)

export default UsageSettings
