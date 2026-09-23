import 'katex/dist/katex.min.css'
import 'katex/dist/contrib/copy-tex'
import 'katex/dist/contrib/mhchem'
import 'remark-github-blockquote-alert/alert.css'

import ImageViewer from '@renderer/components/ImageViewer'
import MarkdownShadowDOMRenderer from '@renderer/components/MarkdownShadowDOMRenderer'
import { useSettings } from '@renderer/hooks/useSettings'
import { useSmoothStream } from '@renderer/hooks/useSmoothStream'
import type { CompactMessageBlock, MainTextMessageBlock, ThinkingMessageBlock } from '@renderer/types/newMessage'
import { removeSvgEmptyLines } from '@renderer/utils/formats'
import { processLatexBrackets } from '@renderer/utils/markdown'
import { isEmpty } from 'lodash'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
// @ts-ignore rehype-mathjax is not typed
import rehypeMathjax from 'rehype-mathjax'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkAlert from 'remark-github-blockquote-alert'
import remarkMath from 'remark-math'
import type { Pluggable } from 'unified'

import { type CitationRegistry, CitationRegistryContext } from './CitationRegistryContext'
import CitationSup from './CitationSup'
import CodeBlock from './CodeBlock'
import Link from './Link'
import MarkdownSvgRenderer from './MarkdownSvgRenderer'
import rehypeHeadingIds from './plugins/rehypeHeadingIds'
import rehypeScalableSvg from './plugins/rehypeScalableSvg'
import remarkDisableConstructs from './plugins/remarkDisableConstructs'
import { remarkHtmlArtifact, transformMarkdownOutsideHtmlArtifacts } from './plugins/remarkHtmlArtifact'
import { scanStandaloneHtmlArtifact } from './standaloneHtmlArtifact'
import Table from './Table'

/** V2 移植：内联 HTML 工件预览模式——流式期间 generating，落定后 ready。 */
export type InlineHtmlPreviewMode = 'generating' | 'ready'

const ALLOWED_ELEMENTS =
  /<(style|p|div|span|b|i|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|blockquote|pre|code|br|hr|svg|path|circle|rect|line|polyline|polygon|text|g|defs|title|desc|tspan|sub|sup|details|summary)/i
const DISALLOWED_ELEMENTS = ['iframe', 'script']

interface Props {
  // message: Message & { content: string }
  block: MainTextMessageBlock | ThinkingMessageBlock | CompactMessageBlock
  // 可选的后处理函数，用于在流式渲染过程中处理文本（如引用标签转换）
  postProcess?: (text: string) => string
  /** 引用 registry（V2 迁移）：编号 → 引用数据，供 Link/CitationSup 查表挂胶囊。 */
  citationRegistry?: CitationRegistry
}

const Markdown: FC<Props> = ({ block, postProcess, citationRegistry }) => {
  const { t } = useTranslation()
  const { mathEngine, mathEnableSingleDollar } = useSettings()

  const isTrulyDone = 'status' in block && block.status === 'success'
  const [displayedContent, setDisplayedContent] = useState(postProcess ? postProcess(block.content) : block.content)
  const [isStreamDone, setIsStreamDone] = useState(isTrulyDone)

  const prevContentRef = useRef(block.content)
  const prevBlockIdRef = useRef(block.id)

  const { addChunk, reset } = useSmoothStream({
    onUpdate: (rawText) => {
      // 如果提供了后处理函数就调用，否则直接使用原始文本
      const finalText = postProcess ? postProcess(rawText) : rawText
      setDisplayedContent(finalText)
    },
    streamDone: isStreamDone,
    initialText: block.content
  })

  useEffect(() => {
    const newContent = block.content || ''
    const oldContent = prevContentRef.current || ''

    const isDifferentBlock = block.id !== prevBlockIdRef.current

    const isContentReset = oldContent && newContent && !newContent.startsWith(oldContent)

    if (isDifferentBlock || isContentReset) {
      reset(newContent)
    } else {
      const delta = newContent.substring(oldContent.length)
      if (delta) {
        addChunk(delta)
      }
    }

    prevContentRef.current = newContent
    prevBlockIdRef.current = block.id

    // 更新 stream 状态
    const isStreaming = block.status === 'streaming'
    setIsStreamDone(!isStreaming)
  }, [block.content, block.id, block.status, addChunk, reset])

  // V2 移植：内联 HTML 预览模式推导（仅 assistant 内容块）。thinking/compact 块同为
  // assistant 内容，按 status 推导是可接受的近似（V2 由 MessagePartsRenderer 按角色门控）。
  const inlineHtmlPreviewMode = useMemo<InlineHtmlPreviewMode | undefined>(() => {
    if (!('status' in block)) return undefined
    if (block.status === 'success') return 'ready'
    if (block.status === 'streaming' || block.status === 'processing' || block.status === 'pending') {
      return 'generating'
    }
    return undefined
  }, [block])

  // V2 defense：显示层内容落后于 block.content（平滑流）时，ready 必须退回 generating，
  // 防止半流文本被当作完整工件送进安全门。
  const effectiveHtmlPreviewMode =
    inlineHtmlPreviewMode === 'ready' && displayedContent !== block.content ? 'generating' : inlineHtmlPreviewMode

  // 整条消息就是一个 HTML 工件时，跳过 Markdown 管线直接走 CodeBlock 渲染面。
  const standaloneArtifact = useMemo(
    () =>
      effectiveHtmlPreviewMode
        ? scanStandaloneHtmlArtifact(block.content, effectiveHtmlPreviewMode === 'generating')
        : undefined,
    [block.content, effectiveHtmlPreviewMode]
  )

  const remarkPlugins = useMemo(() => {
    const plugins = [
      [remarkGfm, { singleTilde: false }] as Pluggable,
      [remarkAlert] as Pluggable,
      remarkCjkFriendly,
      remarkDisableConstructs(['codeIndented'])
    ]
    if (effectiveHtmlPreviewMode) {
      plugins.push(remarkHtmlArtifact)
    }
    if (mathEngine !== 'none') {
      plugins.push([remarkMath, { singleDollarTextMath: mathEnableSingleDollar }])
    }
    return plugins
  }, [mathEngine, mathEnableSingleDollar, effectiveHtmlPreviewMode])

  const messageContent = useMemo(() => {
    if ('status' in block && block.status === 'paused' && isEmpty(block.content)) {
      return t('message.chat.completion.paused')
    }
    const transform = (source: string) => removeSvgEmptyLines(processLatexBrackets(source))
    if (!effectiveHtmlPreviewMode) {
      return transform(displayedContent)
    }
    // V2：>256KB 的流式内容跳过工件解析（解析成本），直接原样渲染。
    if (effectiveHtmlPreviewMode === 'generating' && block.content.length > 256 * 1024) {
      return transform(displayedContent)
    }
    return transformMarkdownOutsideHtmlArtifacts(displayedContent, transform)
  }, [block, displayedContent, t, effectiveHtmlPreviewMode])

  const rehypePlugins = useMemo(() => {
    const plugins: Pluggable[] = []
    if (ALLOWED_ELEMENTS.test(messageContent)) {
      plugins.push(rehypeRaw, rehypeScalableSvg)
    }
    plugins.push([rehypeHeadingIds, { prefix: `heading-${block.id}` }])
    if (mathEngine === 'KaTeX') {
      plugins.push(rehypeKatex)
    } else if (mathEngine === 'MathJax') {
      plugins.push(rehypeMathjax)
    }
    return plugins
  }, [mathEngine, messageContent, block.id])

  const components = useMemo(() => {
    return {
      a: (props: any) => <Link {...props} />,
      sup: (props: any) => <CitationSup {...props} />,
      code: (props: any) => <CodeBlock {...props} blockId={block.id} inlineHtmlPreviewMode={effectiveHtmlPreviewMode} />,
      table: (props: any) => <Table {...props} blockId={block.id} />,
      img: (props: any) => <ImageViewer style={{ maxWidth: 500, maxHeight: 500 }} {...props} />,
      pre: (props: any) => <pre style={{ overflow: 'visible' }} {...props} />,
      p: (props) => {
        const hasImage = props?.node?.children?.some((child: any) => child.tagName === 'img')
        if (hasImage) return <div {...props} />
        return <p {...props} />
      },
      svg: MarkdownSvgRenderer
    } as Partial<Components>
  }, [block.id, effectiveHtmlPreviewMode])

  // Hook 必须在任何早退分支之前调用（下方 standaloneArtifact 早退还直接 return 组件）。
  const urlTransform = useCallback((value: string) => {
    if (value.startsWith('data:image/png') || value.startsWith('data:image/jpeg')) return value
    return defaultUrlTransform(value)
  }, [])

  // V2 移植：整条消息是单个 HTML 工件时，绕过 Markdown 管线直渲染（文档/围栏双源）。
  // position 的 end 外推一个围栏长度，让 isOpenFenceBlock 恒判"已闭合"（V2 语境等价）。
  if (standaloneArtifact) {
    const startOffset = standaloneArtifact.start.offset ?? 0
    const fenceEnd = {
      line: standaloneArtifact.start.line,
      column: standaloneArtifact.start.column + standaloneArtifact.html.length + 7,
      offset: startOffset + standaloneArtifact.html.length + 7
    }
    return (
      <div className="markdown">
        <CodeBlock
          className="language-html"
          inlineHtmlPreviewMode={effectiveHtmlPreviewMode}
          node={{ position: { start: standaloneArtifact.start, end: fenceEnd } } as any}
          blockId={block.id}
          isStreaming={effectiveHtmlPreviewMode === 'generating'}>
          {standaloneArtifact.html}
        </CodeBlock>
      </div>
    )
  }

  if (/<style\b[^>]*>/i.test(messageContent)) {
    components.style = MarkdownShadowDOMRenderer as any
  }

  return (
    <div className="markdown">
      <CitationRegistryContext value={citationRegistry}>
        <ReactMarkdown
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          components={components}
          disallowedElements={DISALLOWED_ELEMENTS}
          urlTransform={urlTransform}
          remarkRehypeOptions={{
            footnoteLabel: t('common.footnotes'),
            footnoteLabelTagName: 'h4',
            footnoteBackContent: ' '
          }}>
          {messageContent}
        </ReactMarkdown>
      </CitationRegistryContext>
    </div>
  )
}

export default memo(Markdown)
