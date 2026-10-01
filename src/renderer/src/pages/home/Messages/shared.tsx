import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

export const ScrollContainer = styled.div`
  display: flex;
  flex-direction: column-reverse;
  padding: 10px 10px 20px;
  .multi-select-mode & {
    padding-bottom: 60px;
  }
`

interface ContainerProps {
  $right?: boolean
}

export const MessagesContainer = styled(Scrollbar)<ContainerProps>`
  display: flex;
  flex-direction: column-reverse;
  overflow-x: hidden;
  z-index: 1;
  position: relative;
`

/**
 * 把消息区滚到**视觉底部**（最新消息）。
 *
 * `#messages`（MessagesContainer）与内部 ScrollContainer 都是 `column-reverse`：
 * 该坐标系下 `scrollTop = 0` 才是视觉底部，`scrollTop = scrollHeight - clientHeight` 是视觉顶部（最旧消息）。
 * 两处“回到底部”入口（锚点线的下箭头、SEND_MESSAGE 事件）必须共用这一个语义，
 * 否则同名函数会各写一套坐标。
 */
export const scrollMessagesToBottom = (element: HTMLElement | null | undefined) => {
  element?.scrollTo({ top: 0 })
}
