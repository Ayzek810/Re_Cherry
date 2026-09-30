import { TranslationOutlined } from '@ant-design/icons'
import { LoadingIcon } from '@renderer/components/Icons'
import type { TranslationMessageBlock } from '@renderer/types/newMessage'
import { Divider } from 'antd'
import type { FC } from 'react'
import { Fragment } from 'react'

import Markdown from '../../Markdown/Markdown'

/**
 * 译文块（消息级原地翻译，V1 MessageTranslate.tsx 逐字移植）：
 * 分隔线（翻译图标）+ 生成中 LoadingIcon（空内容）+ Markdown 译文。
 * 块由 services/messageTranslate.ts 驱动（Redux 投影 + Dexie message_translations 持久层）。
 */
interface Props {
  block: TranslationMessageBlock
}

const MessageTranslate: FC<Props> = ({ block }) => {
  return (
    <Fragment>
      <Divider style={{ margin: 0, marginBottom: 10 }}>
        <TranslationOutlined />
      </Divider>
      {!block.content ? (
        <LoadingIcon color="var(--color-text-2)" style={{ marginBottom: 15 }} />
      ) : (
        <Markdown block={block} />
      )}
    </Fragment>
  )
}

export default MessageTranslate
