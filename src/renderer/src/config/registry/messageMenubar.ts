import { TopicType } from '@renderer/types'

export type MessageMenubarScope = TopicType

export type MessageMenubarButtonId =
  | 'user-regenerate'
  | 'user-edit'
  | 'copy'
  | 'assistant-regenerate'
  | 'assistant-mention-model'
  | 'translate'
  | 'useful'
  | 'delete'
  | 'trace'
  | 'more-menu'
  // dev only
  | 'inspect-data'

export type MessageMenubarScopeConfig = {
  buttonIds: MessageMenubarButtonId[]
  dropdownRootAllowKeys?: string[]
}

export const DEFAULT_MESSAGE_MENUBAR_SCOPE: MessageMenubarScope = TopicType.Chat

// 内部常量：全仓无外部消费方（见 H.md r2-102 的六种消费形态 grep 取证），故不再 export。
const DEFAULT_MESSAGE_MENUBAR_BUTTON_IDS: MessageMenubarButtonId[] = [
  'user-regenerate',
  'user-edit',
  'copy',
  'assistant-regenerate',
  'assistant-mention-model',
  'translate',
  'useful',
  'delete',
  'trace',
  'inspect-data',
  'more-menu'
]

const SESSION_MESSAGE_MENUBAR_BUTTON_IDS: MessageMenubarButtonId[] = ['copy', 'delete', 'more-menu']

// r2-102：`DEFAULT_MESSAGE_MENUBAR_SCOPE` IS `TopicType.Chat`（见上），
// 原先这里还有一行 `[TopicType.Chat, …]`，与 `[DEFAULT_MESSAGE_MENUBAR_SCOPE, …]` 是同一个 Map 键，
// 后者覆盖前者 ⇒ 死条目，已删除。两行内容本就逐字相同，行为不变。
const messageMenubarRegistry = new Map<MessageMenubarScope, MessageMenubarScopeConfig>([
  [DEFAULT_MESSAGE_MENUBAR_SCOPE, { buttonIds: [...DEFAULT_MESSAGE_MENUBAR_BUTTON_IDS] }],
  [TopicType.Session, { buttonIds: [...SESSION_MESSAGE_MENUBAR_BUTTON_IDS], dropdownRootAllowKeys: ['save', 'export'] }]
])

export const getMessageMenubarConfig = (scope: MessageMenubarScope): MessageMenubarScopeConfig => {
  if (messageMenubarRegistry.has(scope)) {
    return messageMenubarRegistry.get(scope) as MessageMenubarScopeConfig
  }
  return messageMenubarRegistry.get(DEFAULT_MESSAGE_MENUBAR_SCOPE) as MessageMenubarScopeConfig
}
