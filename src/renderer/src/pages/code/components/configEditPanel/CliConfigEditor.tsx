import { Wand2 } from 'lucide-react'
import type { FC } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs as AntTabs } from 'antd'

import { useSettings } from '@renderer/hooks/useSettings'
import { formatCliConfigDraftFile } from '@renderer/pages/code/cliConfig'
import type { CliConfigFileDraft } from '@renderer/pages/code/cliConfig'
import { cn } from '@renderer/utils/style'

import { Button, CodeEditor, Tooltip } from '../shadcn'

// fork 移植自 cherry-studio v2 src/renderer/pages/code/components/configEditPanel/CliConfigEditor.tsx
//（2026-09-24，v0.3.4-1 批次4b）。缝点三处，文件 tab 切换/格式化/编辑器体逐字：
// ① 字号缝：V2 usePreference('chat.message.font_size') → fork useSettings().fontSize（同语义面）。
// ② 主题缝：useCmTheme 不搬——fork CodeEditor 内部经 CodeStyleProvider 自取主题（EditorBody 的
//   theme 入参随 shim 的 CodeEditor theme 形参接收不消费）。
// ③ toast 缝：`@renderer/services/toast` → fork window.toast；UI 面（Tabs/Tooltip/Button/CodeEditor）
//   → 本页 shim。hermes 的 yaml/env 编辑器即本文件（fork 语言表：yaml 原生、dotenv→properties
//   降级，见 shim CodeEditor 缝注）。

interface CliConfigEditorProps {
  files: CliConfigFileDraft[]
  error?: string
  onChange: (files: CliConfigFileDraft[]) => void
}

export const CliConfigEditor: FC<CliConfigEditorProps> = ({ files, error, onChange }) => {
  const { t } = useTranslation()
  const { fontSize } = useSettings()
  const [requestedTarget, setRequestedTarget] = useState<string>(files[0]?.target ?? '')
  const activeTarget = files.some((file) => file.target === requestedTarget)
    ? requestedTarget
    : (files[0]?.target ?? '')

  const activeFile = useMemo(
    () => files.find((file) => file.target === activeTarget) ?? files[0],
    [activeTarget, files]
  )

  if (!files.length) return null

  const updateFile = (target: string, content: string) => {
    if (files.find((file) => file.target === target)?.content === content) return
    onChange(files.map((file) => (file.target === target ? { ...file, content } : file)))
  }

  const handleFormat = () => {
    if (!activeFile) return
    try {
      onChange(files.map((file) => (file.target === activeFile.target ? formatCliConfigDraftFile(file) : file)))
    } catch {
      window.toast.error(t('code.cli_config.format_failed'))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-normal text-foreground">{t('code.cli_config.title')}</span>
          <span className="min-w-0 truncate text-[10px] text-foreground-tertiary">{activeFile?.path}</span>
        </div>
        <Tooltip content={t('code.format_json')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('code.format_json')}
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleFormat}
            disabled={activeFile?.language !== 'json'}>
            <Wand2 size={12} />
          </Button>
        </Tooltip>
      </div>

      {files.length > 1 ? (
        // fork 缝（续）：V2 Radix 组合式 Tabs（TabsList/TabsTrigger/TabsContent）改写为 antd Tabs
        // props 式——tab 条视觉以 className 对齐 V2 的 bg-muted/40 小条；requestedTarget 状态语义
        // 逐字（activeTarget 容错回落首项）。
        <AntTabs
          activeKey={activeFile?.target}
          onChange={setRequestedTarget}
          className="min-w-0"
          items={files.map((file) => ({
            key: file.target,
            label: <span className="text-xs">{file.label}</span>,
            children: activeFile?.target === file.target ? (
              <EditorBody file={activeFile} fontSize={fontSize} onChange={updateFile} />
            ) : null
          }))}
        />
      ) : (
        activeFile && <EditorBody file={activeFile} fontSize={fontSize} onChange={updateFile} />
      )}

      {error && (
        <div className="rounded-md border border-error/35 bg-error/15 px-2 py-1.5 text-xs text-error">
          {error}
        </div>
      )}
    </div>
  )
}

const EditorBody: FC<{
  file: CliConfigFileDraft
  fontSize: number
  onChange: (target: string, content: string) => void
}> = ({ file, fontSize, onChange }) => (
  <div className={cn('overflow-hidden rounded-lg border border-border-subtle bg-background')}>
    <CodeEditor
      fontSize={fontSize - 1}
      value={file.content}
      language={file.language === 'dotenv' ? 'dotenv' : file.language}
      onChange={(value) => onChange(file.target, value)}
      height="260px"
      maxHeight="260px"
      expanded={false}
      wrapped
      options={{
        autocompletion: true,
        lineNumbers: true,
        foldGutter: true,
        keymap: true
      }}
    />
  </div>
)
