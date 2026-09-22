/**
 * 引用数据载体块的可见形态："引用 N" 胶囊按钮 + 点开来源清单（CitationsList）。
 *
 * 统一引用机制的数据层不变（kernelChat 由 tool/result meta 建隐形载体），本组件
 * 只是把载体渲染出来：web 来源行（favicon/标题/序号/复制/正文抓取）与知识库行
 * （文档名/序号/复制/摘录）。正文药丸 + 悬浮胶囊（Markdown/Link/CitationSup）
 * 与本卡同源（同一 formatCitationsFromBlock），互不依赖。
 *
 * v0.3.2 验收裁决回顾：3779666 回收的是"专属工具标题卡"机制；本卡是用户明确
 * 要求恢复的独立引用清单（0a8e3ff 误判为不要卡，见 §6.11 验收修复）。旧版的
 * PROCESSING 旋转文案（runtime.websearch.activeSearches）属已删除的 streaming
 * 层，内核路径载体直接以 SUCCESS 建立，不再有处理中形态。
 */
import type { RootState } from '@renderer/store'
import { selectFormattedCitationsByBlockId } from '@renderer/store/messageBlock'
import type { CitationMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import React from 'react'
import { useSelector } from 'react-redux'

import CitationsList from '../CitationsList'

function CitationBlock({ block }: { block: CitationMessageBlock }) {
  const formattedCitations = useSelector((state: RootState) => selectFormattedCitationsByBlockId(state, block.id))

  if (block.status !== MessageBlockStatus.SUCCESS || formattedCitations.length === 0) {
    return null
  }

  return <CitationsList citations={formattedCitations} />
}

export default React.memo(CitationBlock)
