/**
 * 右栏译文面板（V2 components/TranslateOutputPane.tsx 结构，markdown/导出笔记支路删除）：
 * 流式译文 + 复制按钮 + 空态；滚动容器沿用 fork Scrollbar。
 */
import Scrollbar from '@renderer/components/Scrollbar'
import { cn } from '@renderer/utils/style'
import { Empty } from 'antd'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import IconButton from './IconButton'

type Props = {
  translatedContent: string
  translating: boolean
  copied: boolean
  onCopy: () => void
}

const TranslateOutputPane: FC<Props> = ({ translatedContent, translating, copied, onCopy }) => {
  const { t } = useTranslation()

  return (
    <div
      data-ui="translate.output"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <Scrollbar className="flex min-h-0 flex-1 flex-col overflow-x-hidden p-4 pr-12">
        {translating && translatedContent.length === 0 ? (
          <div role="status" aria-live="polite" className="flex flex-1 items-center gap-2 text-muted-foreground">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            <span>{t('common.loading')}</span>
          </div>
        ) : translatedContent.length > 0 ? (
          <div className="wrap-break-word flex-1 whitespace-pre-wrap text-base text-foreground leading-relaxed">
            {translatedContent}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Empty description={t('translate.output_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        )}
      </Scrollbar>
      <div className="absolute top-4 right-3 flex">
        <IconButton
          size="sm"
          onClick={onCopy}
          disabled={translatedContent.length === 0}
          aria-label={t('common.copy')}>
          <Check size={14} className={cn('lucide-custom text-foreground', !copied && 'hidden')} />
          <Copy size={14} className={cn('lucide-custom', copied && 'hidden')} />
        </IconButton>
      </div>
    </div>
  )
}

export default TranslateOutputPane
