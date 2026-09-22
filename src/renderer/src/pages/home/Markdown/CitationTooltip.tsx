/**
 * 引用胶囊（悬浮弹层）——V2 形态的分体式：同一壳，按引用类型分 Web / Knowledge
 * 两种 hover 体。调用方：Markdown 的 Link（有 URL 引用）与 CitationSup（无 URL 引用）。
 *
 * v0.3.2 验收修复（透明窗案）：antd Tooltip 的内衬只承载布局（padding/底色/阴影
 * 全部归零、无箭头），卡体视觉由 TooltipBody 自绘——显式不透明背景 + 描边 +
 * 阴影。主题变量在 antd 传送门内可解析（AntdProvider 的 token 全局用 var() 同证），
 * 但卡底色仍带字面回退值，任何主题层都不再把胶囊画成透明。
 */
import MarqueeText from '@renderer/components/MarqueeText'
import type { Citation } from '@renderer/types'
import { isLinkableCitationUrl } from '@renderer/utils/citation'
import { Tooltip } from 'antd'
import { FileSearch, Globe } from 'lucide-react'
import React, { useMemo } from 'react'
import styled from 'styled-components'

interface CitationTooltipProps {
  children: React.ReactNode
  citation: Citation
}

/** 不透明卡体：胶囊的全部视觉都在这里，不依赖 antd 内衬样式。 */
const TooltipBody = styled.div`
  width: 380px;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  box-sizing: border-box;
  border-radius: 10px;
  background: var(--color-background, #ffffff);
  border: 0.5px solid var(--color-border, rgba(0, 0, 0, 0.15));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  color: var(--color-text-1, rgba(0, 0, 0, 0.88));
`

const TitleRow = styled.a`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1, rgba(0, 0, 0, 0.88));
  text-decoration: none;
  min-width: 0;
`

const SourceIcon = styled.span`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--color-primary, #00b96b);
`

const Snippet = styled.p`
  margin: 0;
  font-size: 12px;
  color: var(--color-text-2, rgba(0, 0, 0, 0.6));
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`

const HostRow = styled.a`
  font-size: 12px;
  color: var(--color-text-3, rgba(0, 0, 0, 0.38));
  text-decoration: none;
  align-self: flex-start;
  &:hover {
    text-decoration: underline;
  }
`

const CitationTooltip: React.FC<CitationTooltipProps> = ({ children, citation }) => {
  const hostname = useMemo(() => {
    try {
      return new URL(citation.url).hostname
    } catch {
      return citation.url
    }
  }, [citation.url])

  const isWeb = isLinkableCitationUrl(citation.url)
  const hasHoverContent = isWeb || Boolean(citation.title?.trim() || citation.content?.trim())
  if (!hasHoverContent) return <>{children}</>

  const openExternal = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(citation.url, '_blank')
  }

  return (
    <Tooltip
      title={
        <TooltipBody>
          {isWeb ? (
            <>
              <TitleRow href={citation.url} target="_blank" onClick={openExternal}>
                <SourceIcon>
                  <Globe size={14} />
                </SourceIcon>
                <MarqueeText>{citation.title?.trim() || hostname}</MarqueeText>
              </TitleRow>
              {citation.content?.trim() && <Snippet>{citation.content}</Snippet>}
              <HostRow href={citation.url} target="_blank" onClick={openExternal}>
                {hostname}
              </HostRow>
            </>
          ) : (
            <>
              {/* 知识库引用：文档名 + 摘录，无外链（V2 KnowledgeCitationHoverContent 同构） */}
              <TitleRow as="div">
                <SourceIcon>
                  <FileSearch size={14} />
                </SourceIcon>
                <MarqueeText>{citation.title?.trim() || 'Knowledge Base'}</MarqueeText>
              </TitleRow>
              {citation.content?.trim() && <Snippet>{citation.content}</Snippet>}
            </>
          )}
        </TooltipBody>
      }
      placement="top"
      arrow={false}
      /* antd 内衬只做布局：视觉全部归零，卡体由 TooltipBody 自绘（透明窗修复） */
      styles={{
        root: { maxWidth: '420px' },
        body: { padding: 0, backgroundColor: 'transparent', boxShadow: 'none' }
      }}
      mouseEnterDelay={0.15}>
      {children}
    </Tooltip>
  )
}

export default CitationTooltip
