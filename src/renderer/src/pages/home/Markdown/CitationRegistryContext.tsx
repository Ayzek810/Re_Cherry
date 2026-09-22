/**
 * 引用 registry 上下文（V2 ChatMarkdownRenderContext 迁移件，仅保留 citation 部分）。
 *
 * data-citation 属性只存编号；引用数据（URL/标题/正文/类型）经由此 context
 * out-of-band 传递（V2 安全加固：不把 JSON 序列化进 HTML 属性）。
 * provider 由 Markdown 组件挂载（components.a / components.sup 消费）。
 */
import type { Citation } from '@renderer/types'
import { createContext, use } from 'react'

export type CitationRegistry = Map<number, Citation>

export const CitationRegistryContext = createContext<CitationRegistry | undefined>(undefined)

export const useCitationRegistry = (): CitationRegistry | undefined => use(CitationRegistryContext)
