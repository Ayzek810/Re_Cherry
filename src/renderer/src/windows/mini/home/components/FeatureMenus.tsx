import { EnterOutlined } from '@ant-design/icons'
import Scrollbar from '@renderer/components/Scrollbar'
import { Col } from 'antd'
import { FileText, Languages, Lightbulb, MessageSquare } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface FeatureMenusProps {
  text: string
  setRoute: Dispatch<SetStateAction<'translate' | 'summary' | 'chat' | 'explanation' | 'home'>>
  onSendMessage: (prompt?: string) => void
}

export interface FeatureMenusRef {
  nextFeature: () => void
  prevFeature: () => void
  useFeature: () => void
  resetSelectedIndex: () => void
}

const FeatureMenus = ({
  ref,
  text,
  setRoute,
  onSendMessage
}: FeatureMenusProps & { ref?: React.RefObject<FeatureMenusRef | null> }) => {
  const { t } = useTranslation()
  const [selectedIndex, setSelectedIndex] = useState(0)

  // fork 缝（v0.3.3-9）：V1/V2 的四项都写成 `if (text) { setRoute(...) }`——剪贴板为空时
  // **点了没有任何反应**（用户报告"快捷助手那个翻译点了没效果"）。改为：一律切路由
  //（各视图自己有空态），没有文本时补一条既有文案的提示；请求侧另有 guard，不会空发。
  // **v0.3.3-1 修复（"快速助手一直不出字"）**：上一版把发送条件写成 `if (prompt)`，而「回答此问题」
  // （chat）在 V2 里本来就是**不带 prompt 也要发**（V2 `FeatureMenus.tsx:36-41`：`setRoute('chat')`
  // + `onSendMessage()`）——于是 fork 的 chat 项只切面板、永不发送，用户按一次回车看不到任何输出
  // （必须再按一次、且第二次已经在 chat 路由上才走 `handleSendMessage`），表现为"快速助手不能用"。
  const openFeature = useCallback(
    (route: 'translate' | 'summary' | 'explanation' | 'chat', prompt?: string) => {
      setRoute(route)
      if (!text) {
        window.toast.info(t('miniwindow.clipboard.empty'))
        return
      }
      // chat：V2 同形，无 prompt 也发（内容取输入框/剪贴板）；其余三项按各自 prompt 发。
      if (route === 'chat' || prompt) onSendMessage(prompt)
    },
    [onSendMessage, setRoute, t, text]
  )

  const features = useMemo(
    () => [
      {
        icon: <MessageSquare size={16} color="var(--color-text)" />,
        title: t('miniwindow.feature.chat'),
        active: true,
        onClick: () => openFeature('chat')
      },
      {
        icon: <Languages size={16} color="var(--color-text)" />,
        title: t('miniwindow.feature.translate'),
        onClick: () => openFeature('translate')
      },
      {
        icon: <FileText size={16} color="var(--color-text)" />,
        title: t('miniwindow.feature.summary'),
        onClick: () => openFeature('summary', t('prompts.summarize'))
      },
      {
        icon: <Lightbulb size={16} color="var(--color-text)" />,
        title: t('miniwindow.feature.explanation'),
        onClick: () => openFeature('explanation', t('prompts.explanation'))
      }
    ],
    [openFeature, t]
  )

  useImperativeHandle(ref, () => ({
    nextFeature() {
      setSelectedIndex((prev) => (prev < features.length - 1 ? prev + 1 : 0))
    },
    prevFeature() {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : features.length - 1))
    },
    useFeature() {
      features[selectedIndex].onClick?.()
    },
    resetSelectedIndex() {
      setSelectedIndex(0)
    }
  }))

  return (
    <FeatureList>
      <FeatureListWrapper>
        {features.map((feature, index) => (
          <Col span={24} key={index}>
            <FeatureItem onClick={feature.onClick} className={index === selectedIndex ? 'active' : ''}>
              <FeatureIcon>{feature.icon}</FeatureIcon>
              <FeatureTitle>{feature.title}</FeatureTitle>
              {index === selectedIndex && <EnterOutlined />}
            </FeatureItem>
          </Col>
        ))}
      </FeatureListWrapper>
    </FeatureList>
  )
}
FeatureMenus.displayName = 'FeatureMenus'

const FeatureList = styled(Scrollbar)`
  flex-shrink: 0;
  height: auto;
  -webkit-app-region: none;
`

const FeatureListWrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
`

const FeatureItem = styled.div`
  display: flex;
  flex-direction: row;
  cursor: pointer;
  transition: background-color 0s;
  background: transparent;
  border: none;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: none;
  border-radius: 8px;
  user-select: none;

  &:hover {
    background: var(--color-background-mute);
  }

  &.active {
    background: var(--color-background-mute);
  }
`

const FeatureIcon = styled.div`
  color: #fff;
  display: flex;
`

const FeatureTitle = styled.h3`
  margin: 0;
  font-size: 14px;
  flex-basis: 100%;
`

export default FeatureMenus
