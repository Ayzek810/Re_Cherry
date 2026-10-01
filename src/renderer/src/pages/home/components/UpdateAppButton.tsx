import { SyncOutlined } from '@ant-design/icons'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { Button } from 'antd'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

/**
 * 更新提示的数据与动作。
 *
 * 抽出来是因为提示在两个布局里各有一处落点：顶部导航（标签栏 / 首页导航栏）用胶囊按钮，
 * 左侧导航模式没有顶栏，只能放在侧栏底部与主题、设置图标并列。两处行为必须一致——
 * 点击都是"开始下载 + 跳到关于页"。
 */
export function useUpdatePrompt() {
  const { update } = useRuntime()
  const navigate = useNavigate()

  const available = update?.phase === 'available' && !update.ignored
  const version = update?.latestVersion ?? ''
  const trigger = useCallback(() => {
    void window.api.update.download()
    navigate('/settings/about')
  }, [navigate])

  return { available, version, trigger }
}

/**
 * 顶栏的"有新版本"提示（顶部导航布局）。
 *
 * 只在"发现可用版本、且该版本没被忽略"时出现。点击属于用户的显式动作：开始下载并跳到
 * 设置 → 关于（进度条与安装按钮都在那一页）。默认不做自动下载，所以这里是唯一的入口。
 * 自动下载打开时，主进程在发现后就已经开始下载，此处点击只是导航。
 */
const UpdateAppButton: FC = () => {
  const { available, version, trigger } = useUpdatePrompt()
  const { t } = useTranslation()

  if (!available) {
    return null
  }

  return (
    <Container>
      <UpdateButton
        className="nodrag"
        onClick={trigger}
        icon={<SyncOutlined />}
        color="primary"
        variant="outlined"
        size="small">
        {t('settings.about.update.available', { version })}
      </UpdateButton>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  align-items: center;
`

const UpdateButton = styled(Button)`
  border-radius: 24px;
  font-size: 12px;
`

export default UpdateAppButton
