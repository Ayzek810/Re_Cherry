/**
 * @interface
 * @description 笔记树节点接口
 */
export interface NotesTreeNode {
  id: string
  name: string // 不包含扩展名
  type: 'folder' | 'file' | 'hint'
  treePath: string // 相对路径
  externalPath: string // 绝对路径
  children?: NotesTreeNode[]
  isStarred?: boolean
  expanded?: boolean
  createdAt: string
  updatedAt: string
}
