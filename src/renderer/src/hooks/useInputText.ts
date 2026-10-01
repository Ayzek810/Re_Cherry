import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseInputTextOptions {
  initialValue?: string
  onChange?: (text: string) => void
}

export interface UseInputTextReturn {
  text: string
  setText: (text: string | ((prev: string) => string)) => void
  prevText: string
  isEmpty: boolean
  clear: () => void
}

/**
 * 管理文本输入状态的通用 Hook
 *
 * 提供文本状态管理、历史追踪和便捷方法
 *
 * @param options - 配置选项
 * @param options.initialValue - 初始文本值
 * @param options.onChange - 文本变化回调
 * @returns 文本状态和操作方法
 *
 * @example
 * ```tsx
 * const { text, setText, isEmpty, clear } = useInputText({
 *   initialValue: '',
 *   onChange: (text) => console.log('Text changed:', text)
 * })
 *
 * <input value={text} onChange={(e) => setText(e.target.value)} />
 * <button disabled={isEmpty}>Send</button>
 * <button onClick={clear}>Clear</button>
 * ```
 */
export function useInputText(options: UseInputTextOptions = {}): UseInputTextReturn {
  const [text, setText] = useState(options.initialValue ?? '')
  const prevTextRef = useRef(text)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  /**
   * r2-68：函数式更新必须交给 React 求值。旧实现
   * `const newText = typeof value === 'function' ? value(text) : value` 读的是渲染期闭包：
   * 同一 tick 的两次函数式更新都基于同一个旧 `text` 计算，第二次覆盖第一次（丢更新）——
   * 这不是 `React.SetStateAction<string>` 的语义。
   *
   * `prevText`/`onChange` 在提交后按最终值维护：同一 tick 的多次更新只通知一次最终值。
   * `prevTextRef` 在提交后同步为当前 `text`，于是下一次渲染读到的 `prevText` 就是变更前的文本。
   */
  const isFirstCommitRef = useRef(true)
  useEffect(() => {
    if (isFirstCommitRef.current) {
      isFirstCommitRef.current = false
      return
    }
    if (prevTextRef.current !== text) {
      optionsRef.current.onChange?.(text)
    }
    prevTextRef.current = text
  }, [text])

  const handleSetText = useCallback((value: string | ((prev: string) => string)) => {
    setText((prev) => (typeof value === 'function' ? value(prev) : value))
  }, [])

  const clear = useCallback(() => {
    handleSetText('')
  }, [handleSetText])

  return {
    text,
    setText: handleSetText,
    prevText: prevTextRef.current,
    isEmpty: text.trim().length === 0,
    clear
  }
}
