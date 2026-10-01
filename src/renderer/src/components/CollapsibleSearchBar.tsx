import type { InputRef } from 'antd'
import { Input, Tooltip } from 'antd'
import { Search } from 'lucide-react'
import { motion } from 'motion/react'
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CollapsibleSearchBarProps {
  onSearch: (text: string) => void
  placeholder?: string
  tooltip?: string
  icon?: React.ReactNode
  maxWidth?: string | number
  style?: React.CSSProperties
}

/**
 * A collapsible search bar for list headers
 * Renders as an icon initially, expands to full search input when clicked
 */
const CollapsibleSearchBar = ({
  onSearch,
  placeholder,
  tooltip,
  icon = <Search size={14} color="var(--color-icon)" />,
  maxWidth = '100%',
  style
}: CollapsibleSearchBarProps) => {
  const [searchVisible, setSearchVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const inputRef = useRef<InputRef>(null)
  // c2-26：默认值原来经默认单例 `i18n.t(...)` 在默认参数里求值；组件被 `memo()` 包住且
  // 三个消费点都不传这两个 prop，于是文案只在父组件恰好重渲染时才刷新。改用 `useTranslation()`，
  // 组件订阅语言变化，默认值在渲染期取。
  const { t } = useTranslation()
  const resolvedPlaceholder = placeholder ?? t('common.search')
  const resolvedTooltip = tooltip ?? t('common.search')

  const handleTextChange = useCallback(
    (text: string) => {
      setSearchText(text)
      onSearch(text)
    },
    [onSearch]
  )

  const handleClear = useCallback(() => {
    setSearchText('')
    setSearchVisible(false)
    onSearch('')
  }, [onSearch])

  useEffect(() => {
    if (searchVisible && inputRef.current) {
      inputRef.current.focus()
    }
  }, [searchVisible])

  return (
    <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
      <motion.div
        initial="collapsed"
        animate={searchVisible ? 'expanded' : 'collapsed'}
        variants={{
          expanded: { maxWidth: maxWidth, opacity: 1, transition: { duration: 0.3, ease: 'easeInOut' } },
          collapsed: { maxWidth: 0, opacity: 0, transition: { duration: 0.3, ease: 'easeInOut' } }
        }}
        style={{ overflow: 'hidden', flex: 1 }}>
        <Input
          ref={inputRef}
          type="text"
          placeholder={resolvedPlaceholder}
          size="small"
          suffix={icon}
          value={searchText}
          autoFocus
          allowClear
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              handleTextChange('')
              if (!searchText) setSearchVisible(false)
            }
          }}
          onBlur={() => {
            if (!searchText) setSearchVisible(false)
          }}
          onClear={handleClear}
          style={{ width: '100%', ...style }}
        />
      </motion.div>
      <motion.div
        initial="visible"
        animate={searchVisible ? 'hidden' : 'visible'}
        variants={{
          visible: { opacity: 1, transition: { duration: 0.1, delay: 0.3, ease: 'easeInOut' } },
          hidden: { opacity: 0, transition: { duration: 0.1, ease: 'easeInOut' } }
        }}
        style={{ cursor: 'pointer', display: 'flex' }}
        onClick={() => setSearchVisible(true)}>
        <Tooltip title={resolvedTooltip} mouseEnterDelay={0.5} mouseLeaveDelay={0}>
          {icon}
        </Tooltip>
      </motion.div>
    </div>
  )
}

export default memo(CollapsibleSearchBar)
