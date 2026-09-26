import type { FC } from 'react'

import type { CodeCli } from '@shared/types/codeCli'

import { CodeCliPageView } from './components/CodeCliPageView'
import { useCodeCliPageViewProps } from './hooks/useCodeCliPageViewProps'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/CodeCliPage.tsx（2026-09-24，v0.3.4-1 批次4b）。
// 逐字；import 面对号（组件/hook ← 本页移植件）。页面挂载（Router/侧栏入口）由批次 5 父代理接。

interface CodeCliPageProps {
  initialTool?: CodeCli
  onToolChange?: (tool: CodeCli) => void
}

const CodeCliPage: FC<CodeCliPageProps> = ({ initialTool, onToolChange }) => {
  const viewProps = useCodeCliPageViewProps(initialTool, onToolChange)
  return <CodeCliPageView {...viewProps} />
}

export default CodeCliPage
