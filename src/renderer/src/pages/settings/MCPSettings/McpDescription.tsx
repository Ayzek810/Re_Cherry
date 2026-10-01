import { loggerService } from '@logger'
import { useCodeStyle } from '@renderer/context/CodeStyleProvider'
import { npxFinder } from '@renderer/utils/npxScopeFinder'
import { Alert, Card } from 'antd'
import DOMPurify from 'dompurify'
import type { FC } from 'react'
import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('McpDescription')

interface McpDescriptionProps {
  searchKey: string
}

const MCPDescription: FC<McpDescriptionProps> = ({ searchKey }) => {
  const { t } = useTranslation()
  const { shikiMarkdownIt } = useCodeStyle()
  const [loading, setLoading] = useState(false)
  const [mcpInfo, setMcpInfo] = useState<string>('')
  // v1 二轮审查 s2-25：npxFinder 失败（离线 / npm 不可达）此前无 rejection handler：
  // 未处理拒绝 + 一张空白 Card ——「这个包没有 README」与「查询失败」不可区分。
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setLoadFailed(false)
    void npxFinder(searchKey)
      .then((packages) => {
        const readme = packages[0]?.original?.readme ?? t('settings.mcp.noDescriptionAvailable')
        void shikiMarkdownIt(readme).then((result) => {
          if (isMounted) setMcpInfo(DOMPurify.sanitize(result))
        })
      })
      .catch((error: unknown) => {
        logger.warn(`Failed to find package description: ${searchKey}`, error as Error)
        if (isMounted) {
          setMcpInfo('')
          setLoadFailed(true)
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false)
      })
    return () => {
      isMounted = false
    }
  }, [shikiMarkdownIt, searchKey, t])

  return (
    <Section>
      <Card loading={loading}>
        {loadFailed ? (
          <Alert
            type="warning"
            showIcon
            message={t('settings.mcp.descriptionUnavailable', {
              defaultValue: 'Failed to fetch the package description.'
            })}
          />
        ) : (
          <div className="markdown" dangerouslySetInnerHTML={{ __html: mcpInfo }} />
        )}
      </Card>
    </Section>
  )
}
const Section = styled.div`
  padding-top: 8px;
  max-width: calc(100vw - var(--sidebar-width) - var(--settings-width) - 75px);
`

export default memo(MCPDescription)
