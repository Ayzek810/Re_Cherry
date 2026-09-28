import { lightbulbVariants } from '@renderer/utils/motionVariants'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { motion } from 'motion/react'
import React, { memo, useMemo, useRef } from 'react'
import styled from 'styled-components'

interface Props {
  isThinking: boolean
  thinkingTimeText: React.ReactNode
  content: string
  expanded: boolean
}

const ThinkingEffect: React.FC<Props> = ({ isThinking, thinkingTimeText, content, expanded }) => {
  // 增量行处理：流式 content 每 token 变化，全文 split 是 O(全文×token) 的平方级开销。
  // 已提交的完整行走 ref 增量追加；仅在前缀断裂（换块/重置/截断）时全量重算。
  const linesRef = useRef<string[]>([])
  const consumedRef = useRef(0)
  const prevContentRef = useRef<string | null>(null)

  const messages = useMemo(() => {
    const src = content || ''
    const prev = prevContentRef.current

    if (prev !== null && src.startsWith(prev.slice(0, consumedRef.current)) && src.length >= consumedRef.current) {
      let delta = src.slice(consumedRef.current)
      let nl = delta.indexOf('\n')
      while (nl !== -1) {
        linesRef.current.push(delta.slice(0, nl))
        consumedRef.current += nl + 1
        delta = delta.slice(nl + 1)
        nl = delta.indexOf('\n')
      }
    } else {
      linesRef.current = []
      consumedRef.current = 0
      let rest = src
      let nl = rest.indexOf('\n')
      while (nl !== -1) {
        linesRef.current.push(rest.slice(0, nl))
        consumedRef.current += nl + 1
        rest = rest.slice(nl + 1)
        nl = rest.indexOf('\n')
      }
    }
    prevContentRef.current = src

    // 与原 split('\n') 语义对齐：committed 完整行 + 末尾未完行；思考中不显示未完行
    const allLines = [...linesRef.current, src.slice(consumedRef.current)]
    const newMessages = isThinking ? allLines.slice(0, -1) : allLines
    return newMessages.filter((line) => line.trim() !== '')
  }, [content, isThinking])

  const showThinking = useMemo(() => {
    return isThinking && !expanded
  }, [expanded, isThinking])

  const LINE_HEIGHT = 14

  const containerHeight = useMemo(() => {
    if (!showThinking || messages.length < 1) return 38
    return Math.min(75, Math.max(messages.length + 1, 2) * LINE_HEIGHT + 25)
  }, [showThinking, messages.length])

  return (
    <ThinkingContainer style={{ height: containerHeight }} className={expanded ? 'expanded' : ''}>
      <LoadingContainer>
        <motion.div variants={lightbulbVariants} animate={isThinking ? 'active' : 'idle'} initial="idle">
          <Lightbulb size={14} style={{ transition: 'width,height, 150ms' }} />
        </motion.div>
      </LoadingContainer>

      <TextContainer>
        <Title className={!showThinking || !messages.length ? 'showThinking' : ''}>{thinkingTimeText}</Title>

        {showThinking && (
          <Content>
            <Messages
              style={{
                height: messages.length * LINE_HEIGHT
              }}
              initial={{
                y: -2
              }}
              animate={{
                y: -messages.length * LINE_HEIGHT - 2
              }}
              transition={{
                duration: 0.15,
                ease: 'linear'
              }}>
              {messages.slice(-5).map((message, index) => (
                <Message key={index}>{message}</Message>
              ))}
            </Messages>
          </Content>
        )}
      </TextContainer>
      <ArrowContainer className={expanded ? 'expanded' : ''}>
        <ChevronRight size={18} color="var(--color-text-3)" strokeWidth={1.5} />
      </ArrowContainer>
    </ThinkingContainer>
  )
}

const ThinkingContainer = styled.div`
  width: 100%;
  border-radius: 10px;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  border: 0.5px solid var(--color-border);
  transition: height, border-radius, 150ms;
  pointer-events: none;
  user-select: none;
  &.expanded {
    border-radius: 10px 10px 0 0;
  }
`

const Title = styled.div`
  position: absolute;
  inset: 0 0 auto 0;
  display: flex;
  align-items: center;
  font-size: 13px;
  line-height: 14px;
  font-weight: 500;
  padding: 10px 0;
  z-index: 99;
  transition: padding-top 150ms;
  &.showThinking {
    padding-top: 12px;
  }

  .thinking-title-main {
    font-size: 13px;
    line-height: 14px;
  }

  .thinking-title-meta {
    font-size: 13px;
    font-weight: 400;
    line-height: 14px;
  }
`

const LoadingContainer = styled.div`
  width: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  flex-shrink: 0;
  position: relative;
  transition: width 150ms;
  > div {
    display: flex;
    justify-content: center;
    align-items: center;
  }
`

const TextContainer = styled.div`
  flex: 1;
  height: 100%;
  padding: 5px 0;
  overflow: hidden;
  position: relative;
`

const Content = styled.div`
  width: 100%;
  height: 100%;
  mask: linear-gradient(
    to bottom,
    rgb(0 0 0 / 0%) 0%,
    rgb(0 0 0 / 0%) 35%,
    rgb(0 0 0 / 25%) 40%,
    rgb(0 0 0 / 100%) 90%,
    rgb(0 0 0 / 100%) 100%
  );
  position: relative;
`

const Messages = styled(motion.div)`
  width: 100%;
  position: absolute;
  top: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
`

const Message = styled.div`
  width: 100%;
  line-height: 14px;
  font-size: 11px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ArrowContainer = styled.div`
  width: 40px;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  flex-shrink: 0;
  position: relative;
  color: var(--color-border);
  transition: transform 150ms;
  &.expanded {
    transform: rotate(90deg);
  }
`

export default memo(ThinkingEffect)
