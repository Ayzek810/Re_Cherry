import { useCallback, useEffect, useRef } from 'react'

interface UseSmoothStreamOptions {
  onUpdate: (text: string) => void
  streamDone: boolean
  minDelay?: number
  initialText?: string
}

const languages = ['en-US', 'zh-CN']
const segmenter = new Intl.Segmenter(languages)

export const useSmoothStream = ({ onUpdate, streamDone, minDelay = 10, initialText = '' }: UseSmoothStreamOptions) => {
  const chunkQueueRef = useRef<string[]>([])
  const animationFrameRef = useRef<number | null>(null)
  const displayedTextRef = useRef<string>(initialText)
  const lastUpdateTimeRef = useRef<number>(0)

  // 回调与流状态走 ref：渲染循环依赖恒定、只挂载一次。之前 renderLoop 依赖
  // [streamDone, onUpdate, minDelay]，而 onUpdate 是调用方每次渲染的内联闭包，
  // 导致每个 displayedContent 更新都 cancel+restart 整个 rAF 循环。
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const streamDoneRef = useRef(streamDone)
  streamDoneRef.current = streamDone
  const minDelayRef = useRef(minDelay)
  minDelayRef.current = minDelay

  const renderLoop = useCallback(
    (currentTime: number) => {
      // 1. 如果队列为空
      if (chunkQueueRef.current.length === 0) {
        // 如果流已结束，确保显示最终状态并停止循环（置空帧号，后续 addChunk 可再唤醒）
        if (streamDoneRef.current) {
          animationFrameRef.current = null
          onUpdateRef.current(displayedTextRef.current)
          return
        }
        // 如果流还没结束但队列空了，等待下一帧
        animationFrameRef.current = requestAnimationFrame(renderLoop)
        return
      }

      // 2. 时间控制，确保最小延迟
      if (currentTime - lastUpdateTimeRef.current < minDelayRef.current) {
        animationFrameRef.current = requestAnimationFrame(renderLoop)
        return
      }
      lastUpdateTimeRef.current = currentTime

      // 3. 动态计算本次渲染的字符数
      let charsToRenderCount = Math.max(1, Math.floor(chunkQueueRef.current.length / 5))

      // 如果流已结束，一次性渲染所有剩余字符
      if (streamDoneRef.current) {
        charsToRenderCount = chunkQueueRef.current.length
      }

      const charsToRender = chunkQueueRef.current.splice(0, charsToRenderCount)
      displayedTextRef.current += charsToRender.join('')

      // 4. 立即更新UI
      onUpdateRef.current(displayedTextRef.current)

      // 5. 如果还有内容需要渲染，继续下一帧
      if (chunkQueueRef.current.length > 0) {
        animationFrameRef.current = requestAnimationFrame(renderLoop)
      } else if (streamDoneRef.current) {
        // 队列排空且流已结束：自然停机，允许后续 addChunk 唤醒
        animationFrameRef.current = null
      }
    },
    [] // 全部状态经 ref 读取，循环自持
  )

  const addChunk = useCallback(
    (chunk: string) => {
      // 逐段 push：之前对整个队列做展开重建（[...queue, ...chars]），长流下是平方级拷贝
      for (const s of segmenter.segment(chunk)) {
        chunkQueueRef.current.push(s.segment)
      }
      // 循环已停机（流结束后又来内容，如重置后的尾部增量）时唤醒
      if (animationFrameRef.current === null) {
        animationFrameRef.current = requestAnimationFrame(renderLoop)
      }
    },
    [renderLoop]
  )

  const reset = useCallback((newText = '') => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    chunkQueueRef.current = []
    displayedTextRef.current = newText
    onUpdateRef.current(newText)
  }, [])

  useEffect(() => {
    // 启动渲染循环（仅挂载时一次）
    animationFrameRef.current = requestAnimationFrame(renderLoop)

    // 组件卸载时清理
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [renderLoop])

  return { addChunk, reset }
}
