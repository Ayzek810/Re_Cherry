import { CodeBlockView, HtmlArtifactsCard } from '@renderer/components/CodeBlockView'
import { isWin, MAX_COLLAPSED_CODE_HEIGHT } from '@renderer/config/constant'
import { useSettings } from '@renderer/hooks/useSettings'
import { MessageHtmlArtifact } from '@renderer/pages/home/Messages/Blocks/MessageHtmlArtifact'
import { ClickableFilePath } from '@renderer/pages/home/Messages/Tools/MessageAgentTools/ClickableFilePath'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { getCodeBlockId, isOpenFenceBlock } from '@renderer/utils/markdown'
import type { Node } from 'mdast'
import React, { memo, useCallback, useMemo } from 'react'

import type { InlineHtmlPreviewMode } from './Markdown'
import { classifyHtmlArtifactSource } from './plugins/remarkHtmlArtifact'

interface Props {
  children: string
  className?: string
  inlineHtmlPreviewMode?: InlineHtmlPreviewMode
  /** standalone 工件直渲染时由调用方传入；ReactMarkdown 常规路径由 isOpenFence 推导。 */
  isStreaming?: boolean
  node?: Omit<Node, 'type'>
  blockId: string // Message block id
  [key: string]: any
}

const CodeBlock: React.FC<Props> = ({ children, className, inlineHtmlPreviewMode, isStreaming = false, node, blockId }) => {
  const languageMatch = /language-([\w-+]+)/.exec(className || '')
  const isMultiline = children?.includes('\n')
  const detectedLanguage = languageMatch?.[1] ?? (isMultiline ? 'text' : null)
  const language = useMemo(() => {
    return detectedLanguage !== 'xml'
      ? detectedLanguage
      : /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(children)
        ? 'svg'
        : detectedLanguage
  }, [children, detectedLanguage])
  const { codeFancyBlock } = useSettings()

  // 代码块 id
  const id = useMemo(() => getCodeBlockId(node?.position?.start), [node?.position?.start])

  // 消息块
  const msgBlock = messageBlocksSelectors.selectById(store.getState(), blockId)
  const isBlockStreaming = useMemo(() => msgBlock?.status === MessageBlockStatus.STREAMING, [msgBlock?.status])

  const handleSave = useCallback(
    (newContent: string) => {
      if (id !== undefined) {
        void EventEmitter.emit(EVENT_NAMES.EDIT_CODE_BLOCK, {
          msgBlockId: blockId,
          codeBlockId: id,
          newContent
        })
      }
    },
    [blockId, id]
  )

  if (language !== null) {
    // Fancy code block
    if (codeFancyBlock) {
      if (language.toLowerCase() === 'html') {
        const isOpenFence = isOpenFenceBlock(children?.length, languageMatch?.[1]?.length, node?.position)
        const isHtmlArtifactStreaming =
          inlineHtmlPreviewMode === 'generating' || isStreaming || isBlockStreaming || isOpenFence
        // The single classification for the whole artifact pipeline: it picks the streaming
        // surface here and travels down as `kind` to decide the safety gate once complete.
        const htmlKind = classifyHtmlArtifactSource(children)

        if (inlineHtmlPreviewMode) {
          // Too short to classify yet — render nothing rather than pick a surface we would
          // have to swap out a few characters later.
          if (isHtmlArtifactStreaming && htmlKind === undefined) return null

          if (isHtmlArtifactStreaming && htmlKind === 'document') {
            return (
              <CodeBlockView
                language={language}
                editable={false}
                isStreaming={isHtmlArtifactStreaming}
                maxHeight={MAX_COLLAPSED_CODE_HEIGHT}
                showToolbar={false}>
                {children}
              </CodeBlockView>
            )
          }

          return (
            <MessageHtmlArtifact
              artifactId={`${blockId}:${id}`}
              html={children}
              onSave={handleSave}
              editable={id !== undefined}
              kind={htmlKind ?? 'fragment'}
              isStreaming={isHtmlArtifactStreaming}
            />
          )
        }

        return <HtmlArtifactsCard html={children} onSave={handleSave} isStreaming={isBlockStreaming && isOpenFence} />
      }
    }

    return (
      <CodeBlockView language={language} onSave={handleSave}>
        {children}
      </CodeBlockView>
    )
  }

  // Detect inline code that looks like an absolute file path (e.g. /Users/foo/bar.tsx)
  // On Windows, Unix-style paths are not valid local paths, so skip detection there.
  if (!isWin && typeof children === 'string' && /^\/[\w.-]+(?:\/[\w.-]+)+$/.test(children)) {
    return (
      <code className={className} style={{ textWrap: 'wrap', fontSize: '95%', padding: '2px 4px' }}>
        <ClickableFilePath path={children} />
      </code>
    )
  }

  return (
    <code className={className} style={{ textWrap: 'wrap', fontSize: '95%', padding: '2px 4px' }}>
      {children}
    </code>
  )
}

export default memo(CodeBlock)
