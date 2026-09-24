/**
 * v0.3.2 自 CS_V1 移植（启动台：顶栏"+"按钮的落地页，路由 /launchpad）。
 *
 * fork 裁剪：上游 9 张入口卡片只保留本 fork 存活路由的四张——知识库（/knowledge）、
 * 文件（/files）、翻译（/translate，v0.3.3 批次3 回归）与绘画（/paintings，
 * v0.3.3 批次4 回归）。上游的 Minapps 区同样不搬：依赖的 MinApp 组件本 fork
 * 不存在（小程序仍从侧栏固定区进入）。
 * 样式与交互照抄上游（6 列网格 + 悬停缩放；bgColor 用 v6 瞬态 prop $bgColor）。
 */
import { FileSearch, Folder, Languages, NotepadText, Palette } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

interface AppMenuItem {
  icon: React.ReactNode
  text: string
  path: string
  bgColor: string
}

const LaunchpadPage: FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const appMenuItems: AppMenuItem[] = [
    {
      icon: <FileSearch size={32} className="icon" />,
      text: t('title.knowledge'),
      path: '/knowledge',
      bgColor: 'linear-gradient(135deg, #10B981, #34D399)'
    },
    {
      icon: <Folder size={32} className="icon" />,
      text: t('title.files'),
      path: '/files',
      bgColor: 'linear-gradient(135deg, #F59E0B, #FBBF24)'
    },
    {
      icon: <Languages size={32} className="icon" />,
      text: t('title.translate'),
      path: '/translate',
      bgColor: 'linear-gradient(135deg, #3B82F6, #60A5FA)'
    },
    {
      icon: <Palette size={32} className="icon" />,
      text: t('title.paintings'),
      path: '/paintings',
      bgColor: 'linear-gradient(135deg, #8B5CF6, #A78BFA)'
    },
    {
      // v0.3.3-2 笔记复活：V1 的启动台同样带这一项（颜色/图标逐字照 V1）
      icon: <NotepadText size={32} className="icon" />,
      text: t('title.notes'),
      path: '/notes',
      bgColor: 'linear-gradient(135deg, #F97316, #FB923C)'
    }
  ]

  return (
    <Container>
      <Content>
        <Section>
          <SectionTitle>{t('launchpad.apps')}</SectionTitle>
          <Grid>
            {appMenuItems.map((item) => (
              <AppIcon key={item.path} onClick={() => navigate(item.path)}>
                <IconContainer>
                  <IconWrapper $bgColor={item.bgColor}>{item.icon}</IconWrapper>
                </IconContainer>
                <AppName>{item.text}</AppName>
              </AppIcon>
            ))}
          </Grid>
        </Section>
      </Content>
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  background-color: var(--color-background);
  overflow-y: auto;
  padding: 50px 0;
`
const Content = styled.div`
  max-width: 720px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
`
const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`
const SectionTitle = styled.h2`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  opacity: 0.8;
  margin: 0;
  padding: 0 36px;
`
const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  padding: 0 8px;
`
const AppIcon = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 16px;
  transition: transform 0.2s ease;
  &:hover {
    transform: scale(1.05);
  }
  &:active {
    transform: scale(0.95);
  }
`
const IconContainer = styled.div`
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 56px;
  height: 56px;
`
const IconWrapper = styled.div<{ $bgColor: string }>`
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: ${(props) => props.$bgColor};
  display: flex;
  justify-content: center;
  align-items: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  .icon {
    color: white;
    width: 28px;
    height: 28px;
  }
`
const AppName = styled.div`
  font-size: 12px;
  color: var(--color-text);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default LaunchpadPage
