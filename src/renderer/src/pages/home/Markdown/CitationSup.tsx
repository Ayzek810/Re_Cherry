/**
 * Markdown 所有的 <sup> 渲染组件（V2 迁移件）。
 *
 * 职责：
 * - 引用徽章样式（sup[data-citation] 药丸）—— fork 用 styled-components 内联
 *   （V2 是全局 markdown.css，fork 的 Markdown 渲染不保证全局样式注入）。
 * - 无 URL 引用（知识库/记忆）在裸 sup 上挂悬浮胶囊（role=button 可键盘触发）；
 *   有 URL 的引用由 Link 组件挂弹层，此处直通，避免双弹层。
 * - 普通语义上标（如 E=mc²）原样渲染。
 */
import type { Citation } from '@renderer/types'
import { isLinkableCitationUrl } from '@renderer/utils/citation'
import React, { use, useMemo } from 'react'
import styled from 'styled-components'

import { CitationRegistryContext } from './CitationRegistryContext'
import CitationTooltip from './CitationTooltip'

/** 药丸徽章（V2 markdown.css sup[data-citation] 的 styled-components 版）。 */
const CitationBadge = styled.sup`
  top: -0.45em;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 1.55em;
  height: 1.55em;
  padding: 0 0.25em;
  /* 相邻药丸间距（一个论断挂两个来源的连续标记） */
  margin: 0 0.12em;
  line-height: 1;
  border-radius: 999px;
  background-color: var(--color-primary-mute);
  color: var(--color-primary);
  font-size: 0.75em;
  cursor: pointer;
`

interface CitationSupProps extends React.HTMLAttributes<HTMLElement> {
  node?: unknown
}

/**
 * Markdown components.sup —— 渲染所有 <sup>。
 * data-citation 命中 registry 且无外链 URL 时挂胶囊，其余原样渲染。
 */
const CitationSup: React.FC<CitationSupProps> = (props) => {
  const registry = use(CitationRegistryContext)
  const number = typeof props['data-citation'] === 'string' ? parseInt(props['data-citation'], 10) : NaN
  const citation: Citation | undefined = useMemo(
    () => (registry && !Number.isNaN(number) ? registry.get(number) : undefined),
    [registry, number]
  )

  if (citation && !isLinkableCitationUrl(citation.url)) {
    return (
      <CitationTooltip citation={citation}>
        <CitationBadge
          data-citation={props['data-citation']}
          role="button"
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}>
          {props.children}
        </CitationBadge>
      </CitationTooltip>
    )
  }

  if (citation) {
    // 有 URL 的引用：Link 已挂弹层，这里只保证徽章视觉。
    return <CitationBadge data-citation={props['data-citation']}>{props.children}</CitationBadge>
  }

  // 普通语义上标
  return <sup {...props}>{props.children}</sup>
}

export default CitationSup
