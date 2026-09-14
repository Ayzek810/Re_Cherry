import { ActionIconButton } from '@renderer/components/Buttons'
import {
  MdiLightbulbAutoOutline,
  MdiLightbulbOffOutline,
  MdiLightbulbOn,
  MdiLightbulbOn30,
  MdiLightbulbOn50,
  MdiLightbulbOn80,
  MdiLightbulbOn90,
  MdiLightbulbQuestion
} from '@renderer/components/Icons/SVGIcon'
import { QuickPanelReservedSymbol, useQuickPanel } from '@renderer/components/QuickPanel'
import { isFixedReasoningModel, isGPT5SeriesReasoningModel, isOpenAIWebSearchModel } from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { Model, ThinkingOption } from '@renderer/types'
import { reasoningOptionsForModel } from '@renderer/utils/reasoningKernel'
import { Tooltip } from 'antd'
import type { FC, ReactElement } from 'react'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  quickPanel: ToolQuickPanelApi
  model: Model
  assistantId: string
  // Controlled mode: external state management (for agent sessions)
  reasoningEffort?: ThinkingOption
  onReasoningEffortChange?: (option: ThinkingOption) => void
}

const ThinkingButton: FC<Props> = ({
  quickPanel,
  model,
  assistantId,
  reasoningEffort: controlledEffort,
  onReasoningEffortChange
}): ReactElement => {
  const { t } = useTranslation()
  const quickPanelHook = useQuickPanel()
  const isControlled = controlledEffort !== undefined
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)

  const currentReasoningEffort = useMemo(() => {
    if (isControlled) return controlledEffort
    return assistant.settings?.reasoning_effort || 'none'
  }, [isControlled, controlledEffort, assistant.settings?.reasoning_effort])

  const isFixedReasoning = isFixedReasoningModel(model)

  // 思考档位选项：模型无关、常驻 关/自动/低/中/高/满
  const supportedOptions: ThinkingOption[] = useMemo(() => reasoningOptionsForModel(model), [model])

  const onThinkingChange = useCallback(
    (option: ThinkingOption) => {
      const isEnabled = option !== 'none'

      if (isControlled) {
        onReasoningEffortChange?.(option)
        return
      }

      if (!isEnabled) {
        updateAssistantSettings({
          reasoning_effort: option,
          reasoning_effort_cache: option,
          qwenThinkMode: false
        })
        return
      }
      if (
        isOpenAIWebSearchModel(model) &&
        isGPT5SeriesReasoningModel(model) &&
        assistant.enableWebSearch &&
        option === 'minimal'
      ) {
        window.toast.warning(t('chat.web_search.warning.openai'))
        return
      }
      updateAssistantSettings({
        reasoning_effort: option,
        reasoning_effort_cache: option,
        qwenThinkMode: true
      })
    },
    [isControlled, onReasoningEffortChange, updateAssistantSettings, assistant.enableWebSearch, model, t]
  )

  const reasoningEffortOptionLabelMap = {
    default: t('assistants.settings.reasoning_effort.default'),
    none: t('assistants.settings.reasoning_effort.off'),
    minimal: t('assistants.settings.reasoning_effort.minimal'),
    high: t('assistants.settings.reasoning_effort.high'),
    low: t('assistants.settings.reasoning_effort.low'),
    medium: t('assistants.settings.reasoning_effort.medium'),
    auto: t('assistants.settings.reasoning_effort.auto'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh'),
    max: t('assistants.settings.reasoning_effort.xhigh')
  } as const satisfies Record<ThinkingOption, string>

  const reasoningEffortDescriptionMap = {
    default: t('assistants.settings.reasoning_effort.default_description'),
    none: t('assistants.settings.reasoning_effort.off_description'),
    minimal: t('assistants.settings.reasoning_effort.minimal_description'),
    low: t('assistants.settings.reasoning_effort.low_description'),
    medium: t('assistants.settings.reasoning_effort.medium_description'),
    high: t('assistants.settings.reasoning_effort.high_description'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh_description'),
    max: t('assistants.settings.reasoning_effort.xhigh_description'),
    auto: t('assistants.settings.reasoning_effort.auto_description')
  } as const satisfies Record<ThinkingOption, string>

  const panelItems = useMemo(() => {
    // 使用表中定义的选项创建UI选项
    return supportedOptions.map((option) => ({
      level: option,
      label: reasoningEffortOptionLabelMap[option],
      description: reasoningEffortDescriptionMap[option],
      icon: ThinkingIcon({ option }),
      isSelected: currentReasoningEffort === option,
      action: () => onThinkingChange(option)
    }))
  }, [
    supportedOptions,
    reasoningEffortOptionLabelMap,
    reasoningEffortDescriptionMap,
    currentReasoningEffort,
    onThinkingChange
  ])

  const isThinkingEnabled =
    currentReasoningEffort !== undefined && currentReasoningEffort !== 'none' && currentReasoningEffort !== 'default'

  /**
   * 当前能否"一键关闭思考"：思考已开启，且档位表里有"关"（none）这一项。
   *
   * 历史：v0.3.0 之前该条件还要求"非多档模型"（`!hasMultipleLevels`），但档位表改成
   * **模型无关常驻六项**（`reasoningOptionsForModel`）之后，"含 none"必然意味着同时含
   * low/medium/high → `hasMultipleLevels` 恒为 true → 该分支永不成立，"一键关闭"实际消失
   * （`disableThinking` 沦为死代码）。v0.3.0-1 按用户裁决恢复该交互：只要有"关"这一项，
   * 点一下就直接关掉，不再看档位数。
   */
  const canTurnOffThinking = isThinkingEnabled && supportedOptions.includes('none')

  const disableThinking = useCallback(() => {
    onThinkingChange('none')
  }, [onThinkingChange])

  const openQuickPanel = useCallback(() => {
    quickPanelHook.open({
      title: t('assistants.settings.reasoning_effort.label'),
      list: panelItems,
      symbol: QuickPanelReservedSymbol.Thinking
    })
  }, [quickPanelHook, panelItems, t])

  const handleOpenQuickPanel = useCallback(() => {
    if (isFixedReasoning) return

    if (quickPanelHook.isVisible && quickPanelHook.symbol === QuickPanelReservedSymbol.Thinking) {
      quickPanelHook.close()
      return
    }

    // 已开启思考且面板里有"关" → 点一下直接关闭（一键关闭，见 canTurnOffThinking 的说明）
    if (canTurnOffThinking) {
      disableThinking()
      return
    }
    openQuickPanel()
  }, [openQuickPanel, quickPanelHook, canTurnOffThinking, disableThinking, isFixedReasoning])

  useEffect(() => {
    if (isFixedReasoning) return

    const disposeMenu = quickPanel.registerRootMenu([
      {
        label: t('assistants.settings.reasoning_effort.label'),
        description: '',
        icon: ThinkingIcon({ option: currentReasoningEffort }),
        isMenu: true,
        action: () => openQuickPanel()
      }
    ])

    const disposeTrigger = quickPanel.registerTrigger(QuickPanelReservedSymbol.Thinking, () => openQuickPanel())

    return () => {
      disposeMenu()
      disposeTrigger()
    }
  }, [currentReasoningEffort, openQuickPanel, quickPanel, t, isFixedReasoning])

  // 提示语与点击行为必须一致（v0.3.0-1 修正：此前"多档且已开启"给的是"Reasoning Effort"，
  // 但那时点击其实会打开面板——档位重构后点击变成"关闭"，标签不改就会再次出现标签与行为不符）：
  // - 固定推理模型：永远"Thinking"（点击无响应）
  // - 可一键关闭（已开启且有"关"）："Close"（点击即关闭）
  // - 其余（未开启，或档位表里没有"关"）："Reasoning Effort"（点击打开面板）
  const ariaLabel = isFixedReasoning
    ? t('chat.input.thinking.label')
    : canTurnOffThinking
      ? t('common.close')
      : t('assistants.settings.reasoning_effort.label')

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={handleOpenQuickPanel}
        active={isFixedReasoning || currentReasoningEffort !== 'none'}
        aria-label={ariaLabel}
        aria-pressed={currentReasoningEffort !== 'none'}
        style={isFixedReasoning ? { cursor: 'default' } : undefined}>
        {ThinkingIcon({ option: currentReasoningEffort, isFixedReasoning })}
      </ActionIconButton>
    </Tooltip>
  )
}

const ThinkingIcon = (props: { option?: ThinkingOption; isFixedReasoning?: boolean }) => {
  let IconComponent: React.FC<React.SVGProps<SVGSVGElement>> | null = null
  if (props.isFixedReasoning) {
    IconComponent = MdiLightbulbAutoOutline
  } else {
    switch (props.option) {
      case 'minimal':
        IconComponent = MdiLightbulbOn30
        break
      case 'low':
        IconComponent = MdiLightbulbOn50
        break
      case 'medium':
        IconComponent = MdiLightbulbOn80
        break
      case 'high':
        IconComponent = MdiLightbulbOn90
        break
      // `max`（UI 常驻档位的最高档）与 xhigh 同图标：v0.3.0 引入 REASONING_UI_OPTIONS 时
      // 漏了这个 case，导致"满"档落到 default 分支显示问号（"未知"）图标——label/description
      // 侧当时已为 max 复用 xhigh 文案，故这里是遗漏而非设计（v0.3.0-1 后续修复）。
      // 注：注释必须放在 case 'xhigh' **之前**——夹在两个 case 之间会被 no-fallthrough 判警告。
      case 'xhigh':
      case 'max':
        IconComponent = MdiLightbulbOn
        break
      case 'auto':
        IconComponent = MdiLightbulbAutoOutline
        break
      case 'none':
        IconComponent = MdiLightbulbOffOutline
        break
      case 'default':
      default:
        IconComponent = MdiLightbulbQuestion
        break
    }
  }

  return <IconComponent className="icon" width={18} height={18} style={{ marginTop: -2 }} />
}

export default ThinkingButton
