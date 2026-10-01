import { Modal, Skeleton } from 'antd'
import { lazy, Suspense, useState } from 'react'

import { TopView } from '../TopView'

// HistoryPage 不是路由页（Router.tsx 不含它），它唯一的消费方就是本弹窗。
// 静态导入会经 services/MessagesService → 首屏 eager 链把整棵历史页子树
//（SearchMessage/SearchResults/TopicMessages/TopicsHistory + messageThunk）钉进首屏包，
// 抵消路由级懒加载的收益。改为动态导入：只有用户真的点开搜索时才加载。
const HistoryPage = lazy(() => import('@renderer/pages/history/HistoryPage'))

/** 弹窗体高 80vh，骨架必须占据同形空间。 */
const HistoryPageFallback = () => (
  <div style={{ padding: 16 }} role="status" aria-busy="true" aria-live="polite">
    <Skeleton active paragraph={{ rows: 8 }} />
  </div>
)

interface Props {
  resolve: (data: any) => void
}

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)

  const onOk = () => {
    setOpen(false)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  SearchPopup.hide = onCancel

  return (
    <Modal
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      afterClose={onClose}
      title={null}
      width={700}
      transitionName="animation-move-down"
      styles={{
        content: {
          borderRadius: 20,
          padding: 0,
          overflow: 'hidden',
          paddingBottom: 16
        },
        body: {
          height: '80vh',
          maxHeight: 'inherit',
          padding: 0
        }
      }}
      centered
      closable={false}
      footer={null}>
      <Suspense fallback={<HistoryPageFallback />}>
        <HistoryPage />
      </Suspense>
    </Modal>
  )
}

export default class SearchPopup {
  static topviewId = 0
  static hide() {
    TopView.hide('SearchPopup')
  }
  static show() {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            TopView.hide('SearchPopup')
          }}
        />,
        'SearchPopup'
      )
    })
  }
}
