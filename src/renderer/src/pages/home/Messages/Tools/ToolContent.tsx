/**
 * 统一工具卡内容渲染器：参数区 + 输出区 + 状态语义。
 * 所有工具共用同一框架（一轮一条回答、所有工具共用统一卡片的三铁律之二）；
 * ask_user_question 是其中一种内容：有未决请求时渲染可作答的选项，历史/已答时渲染只读问答。
 */
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { userQuestionsActions } from '@renderer/store/userQuestions'
import type { ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { Button, Input, Tag } from 'antd'
import { CornerDownLeft } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { askUserToolName } from './toolDisplay'

interface ToolContentProps {
  block: ToolMessageBlock
}

// ============ 通用内容：参数区 + 输出区 ============

const ContentContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 4px 12px 8px 34px;
  min-width: 0;
`

const ParamRow = styled.div`
  display: flex;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  min-width: 0;

  .param-key {
    color: var(--color-text-3);
    flex-shrink: 0;
    font-family: var(--font-family-mono);
  }

  .param-value {
    color: var(--color-text-2);
    font-family: var(--font-family-mono);
    white-space: pre-wrap;
    word-break: break-all;
    min-width: 0;
  }
`

const OutputText = styled.div<{ $isError: boolean }>`
  font-size: 12px;
  line-height: 18px;
  color: ${(props) => (props.$isError ? 'var(--color-status-warning, #faad14)' : 'var(--color-text-2)')};
  font-family: var(--font-family-mono);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-background-soft, transparent);
  border: 0.5px solid var(--color-border);
  border-radius: 6px;
  padding: 6px 8px;
`

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const GenericToolContent: React.FC<{ block: ToolMessageBlock }> = ({ block }) => {
  const args = block.arguments
  const paramEntries = useMemo(() => {
    if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) return []
    return Object.entries(args as Record<string, unknown>).filter(([, value]) => value !== undefined)
  }, [args])
  const output = typeof block.content === 'string' ? block.content : ''
  const isError = block.status === MessageBlockStatus.ERROR

  if (paramEntries.length === 0 && output.length === 0) return null

  return (
    <ContentContainer>
      {paramEntries.map(([key, value]) => (
        <ParamRow key={key}>
          <span className="param-key">{key}</span>
          <span className="param-value">{stringifyValue(value)}</span>
        </ParamRow>
      ))}
      {output.length > 0 && <OutputText $isError={isError}>{output}</OutputText>}
    </ContentContainer>
  )
}

// ============ ask_user_question：统一卡内的一种内容 ============

interface QuestionArgs {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multi_select?: boolean
}

const QuestionBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;

  .question-header {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text);
  }

  .question-text {
    font-size: 13px;
    color: var(--color-text-1);
  }
`

const OptionButton = styled(Button)`
  justify-content: flex-start;
  text-align: left;
  white-space: normal;
  height: auto;
  min-height: 28px;
  padding: 4px 10px;

  .option-inner {
    display: flex;
    flex-direction: column;
    gap: 1px;
    align-items: flex-start;

    .option-label {
      font-size: 13px;
    }

    .option-description {
      font-size: 12px;
      color: var(--color-text-3);
      white-space: normal;
    }
  }
`

const AnswerRow = styled(ParamRow)``

const AskUserContent: React.FC<{ block: ToolMessageBlock }> = ({ block }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const args = block.arguments as Record<string, unknown> | undefined
  const questions = useMemo(() => {
    const raw = args?.questions
    return Array.isArray(raw) ? (raw as QuestionArgs[]) : []
  }, [args])
  // 未决问答：按 callId 配对（投影时 toolId = callId）
  const pendingEntry = useAppSelector((state) =>
    Object.values(state.userQuestions.pending).find((entry) => entry.callId === block.toolId)
  )
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})

  // 历史问答：从工具结果（JSON 文本）解析已选答案
  const answers = useMemo(() => {
    if (pendingEntry !== undefined) return []
    if (typeof block.content !== 'string' || block.content.length === 0) return []
    try {
      const parsed = JSON.parse(block.content) as { answers?: { id: string; selected?: string[]; custom?: string }[] }
      return Array.isArray(parsed.answers) ? parsed.answers : []
    } catch {
      return []
    }
  }, [pendingEntry, block.content])

  const canSubmit = useMemo(() => {
    if (pendingEntry === undefined) return false
    return pendingEntry.questions.every((question) => {
      const picked = selections[question.id] ?? []
      return picked.length > 0 || (customs[question.id]?.trim().length ?? 0) > 0
    })
  }, [pendingEntry, selections, customs])

  if (questions.length === 0 && answers.length === 0) return null

  // 单问 + 单选：点选项即整份提交；其余形态（多问/多选/纯自由输入）收集后按提交按钮发送
  const immediateSubmit =
    questions.length === 1 && questions[0].multi_select !== true && (questions[0].options?.length ?? 0) > 0

  const submitWithSelections = (finalSelections: Record<string, string[]>): void => {
    if (pendingEntry === undefined) return
    const requestAnswers = pendingEntry.questions.map((question) => {
      const custom = customs[question.id]?.trim()
      return {
        id: question.id,
        selected: finalSelections[question.id] ?? [],
        ...(custom !== undefined && custom.length > 0 ? { custom } : {})
      }
    })
    dispatch(userQuestionsActions.requestAnswered({ requestId: pendingEntry.requestId }))
    void window.api.dshQuestionAnswer({ requestId: pendingEntry.requestId, answers: requestAnswers })
  }

  const handleOptionClick = (question: QuestionArgs, option: { label: string }): void => {
    if (pendingEntry === undefined) return
    if (immediateSubmit) {
      submitWithSelections({ [question.id]: [option.label] })
      return
    }
    const multi = question.multi_select === true
    setSelections((prev) => {
      const picked = prev[question.id] ?? []
      if (!multi) return { ...prev, [question.id]: [option.label] }
      const next = picked.includes(option.label)
        ? picked.filter((label) => label !== option.label)
        : [...picked, option.label]
      return { ...prev, [question.id]: next }
    })
  }

  return (
    <ContentContainer>
      {questions.map((question) => (
        <QuestionBlock key={question.id}>
          {question.header && <span className="question-header">{question.header}</span>}
          <span className="question-text">{question.question}</span>
          {pendingEntry !== undefined && question.options !== undefined && (
            <>
              {question.options.map((option) => (
                <OptionButton
                  key={option.label}
                  size="small"
                  variant="outlined"
                  color="primary"
                  onClick={() => handleOptionClick(question, option)}>
                  <span className="option-inner">
                    <span className="option-label">{option.label}</span>
                    {option.description && <span className="option-description">{option.description}</span>}
                  </span>
                </OptionButton>
              ))}
            </>
          )}
          {pendingEntry !== undefined && (question.options === undefined || question.options.length === 0) && (
            <Input
              size="small"
              placeholder={t('message.tools.question.customPlaceholder')}
              value={customs[question.id] ?? ''}
              onChange={(event) => setCustoms((prev) => ({ ...prev, [question.id]: event.target.value }))}
              onPressEnter={() => submitWithSelections(selections)}
            />
          )}
        </QuestionBlock>
      ))}
      {pendingEntry !== undefined && !immediateSubmit && (
        <div>
          <Button
            size="small"
            type="primary"
            disabled={!canSubmit}
            onClick={() => submitWithSelections(selections)}
            icon={<CornerDownLeft size={13} />}>
            {t('message.tools.question.submit')}
          </Button>
        </div>
      )}
      {answers.map((answer) => (
        <AnswerRow key={answer.id}>
          <span className="param-key">{answer.id}</span>
          <span className="param-value">
            {answer.selected?.map((label) => (
              <Tag key={label} color="blue" style={{ marginInlineEnd: 4 }}>
                {label}
              </Tag>
            ))}
            {answer.custom}
          </span>
        </AnswerRow>
      ))}
    </ContentContainer>
  )
}

const ToolContent: React.FC<ToolContentProps> = ({ block }) => {
  if (block.toolName === askUserToolName) return <AskUserContent block={block} />
  return <GenericToolContent block={block} />
}

export default ToolContent
