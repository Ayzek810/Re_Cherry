import { useCallback, useState } from 'react'

/**
 * 输入框草稿（v1 二轮审查 s2-14）。
 *
 * `settings` 切片是 redux-persist 持久化的，且 persist 配置没有节流：`onChange` 里直接
 * `dispatch` 等于**每敲一个字符**就「序列化整片 settings + 写 localStorage」一次，全部发生在
 * 主线程——粘贴一段 100+ 字符的密钥就是 100+ 次全量写。同目录的 `WebDavSettings` /
 * `LocalBackupSettings` 早已是「本地草稿 + 失焦提交」的约定，这里把该约定收敛成一个 hook。
 *
 * 返回的 `value` 在未编辑时始终跟随外部真值（`committed`），所以外部改动不会被本地草稿挡住。
 */
export interface CommittedInputHandlers {
  value: string
  onChange: (event: { target: { value: string } }) => void
  onBlur: (event: { target: { value: string } }) => void
}

export function useCommittedInput(
  committed: string | null | undefined,
  commit: (next: string) => void
): CommittedInputHandlers {
  // null = 未编辑，值跟随外部真值
  const [draft, setDraft] = useState<string | null>(null)

  const onChange = useCallback((event: { target: { value: string } }) => {
    setDraft(event.target.value)
  }, [])

  const onBlur = useCallback(
    (event: { target: { value: string } }) => {
      const next = event.target.value
      setDraft(null)
      // 值没变就不写：避免「点一下输入框再离开」也产生一次整片持久化。
      if (next !== (committed ?? '')) {
        commit(next)
      }
    },
    [commit, committed]
  )

  return { value: draft ?? committed ?? '', onChange, onBlur }
}
