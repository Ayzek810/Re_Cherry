/**
 * 内联自 V1 基线 `packages/extension-table-plus`（v0.3.3-2 笔记移植；原样拷贝，只去掉相对 import 的
 * `.js` 后缀）。Cherry 自维护的 tiptap 表格扩展：比官方 `@tiptap/extension-table` 多两个钩子
 * （`onRowActionClick` / `onColumnActionClick`，驱动行/列操作菜单）与 `tableCell.allowNestedNodes`。
 * 内联而非 workspace 包：原包 exports 指向 dist/、需 tsdown 构建，fork 没有那条链。
 */
export * from './cell/index'
export * from './header/index'
export * from './kit/index'
export * from './row/index'
export * from './table/index'
export * from './table/TableView'
