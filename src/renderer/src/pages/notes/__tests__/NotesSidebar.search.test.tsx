/**
 * notes 侧栏的检索状态面与分片上下文稳定性。
 *
 * `useFullTextSearch` 返回的 `error` 零消费、`searchStats.total === 0` 时只有一片空列表——
 * 整棵树读失败与"没有匹配"在界面上同形（「failure must never look like an empty result」；
 * 「Silent invisibility is the worst failure mode」）。现在补三条状态：失败（带重试）、
 * 0 命中占位、部分文件读取失败。
 *
 * `inPlaceEdit` 由 `useInPlaceEdit` 每次渲染返回新对象、`NotesUIContext` 传的是内联字面量，
 * 于是 `NotesEditingContext` / `NotesUIContext` 每渲染换引用 ⇒ `memo` 的 TreeNode 全量重渲染。
 *
 * 行为级断言：① 失败 → 错误条 + 重试（点击真的重发检索），且不渲染空态；
 * ② 0 命中 → `notes.search.no_results` 占位；③ 有文件读失败 → 部分失败条；
 * ④ 与上下文无关的状态变化后，editing/actions/ui 三个上下文值保持同一引用。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import NotesSidebar from '../NotesSidebar'

interface SearchState {
  isSearching: boolean
  results: unknown[]
  stats: { total: number; fileNameMatches: number; contentMatches: number; bothMatches: number }
  error: Error | null
  failedFiles: number
  failureMessage: string | null
  searchedKeyword: string | null
}

const harness = vi.hoisted(() => {
  const records: Array<{ editing: unknown; actions: unknown; ui: unknown }> = []
  const search = vi.fn()
  const reset = vi.fn()
  const state: SearchState = {
    isSearching: false,
    results: [],
    stats: { total: 0, fileNameMatches: 0, contentMatches: 0, bothMatches: 0 },
    error: null,
    failedFiles: 0,
    failureMessage: null,
    searchedKeyword: null
  }
  return { records, search, reset, state }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: () => 'updated_desc'
}))

vi.mock('@renderer/store/note', () => ({
  selectSortType: (state: unknown) => state
}))

vi.mock('@renderer/hooks/useNotesQuery', () => ({
  useActiveNode: () => ({ activeNode: null })
}))

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({
    list,
    children
  }: {
    list: Array<{ node: { id: string }; depth: number }>
    children: (item: { node: { id: string }; depth: number }, index: number) => React.ReactNode
  }) => <div>{list.map((item, index) => children(item, index))}</div>
}))

vi.mock('../NotesSidebarHeader', () => ({
  default: ({
    onSetSearchKeyword,
    onToggleSearchView,
    onToggleStarredView
  }: {
    onSetSearchKeyword: (keyword: string) => void
    onToggleSearchView: () => void
    onToggleStarredView: () => void
  }) => (
    <div>
      <button type="button" data-testid="toggle-search" onClick={onToggleSearchView} />
      <button type="button" data-testid="toggle-starred" onClick={onToggleStarredView} />
      <input data-testid="search-input" onChange={(event) => onSetSearchKeyword(event.target.value)} />
    </div>
  )
}))

// TreeNode 是 memo 的上下文消费者：这里把它换成"探针"，记录它每次渲染看到的三个上下文值。
vi.mock('../components/TreeNode', async () => {
  const { useNotesActions, useNotesEditing, useNotesUI } = await import('../context/NotesContexts')
  // 具名组件（大写开头）而不是匿名箭头：匿名默认导出会让 rules-of-hooks 认为这三个 hook
  // 调用落在普通函数里。具名后既是真组件，也不需要 disable 注释。
  function TreeNodeProbe({ node }: { node: { id: string } }) {
    harness.records.push({
      editing: useNotesEditing(),
      actions: useNotesActions(),
      ui: useNotesUI()
    })
    return <div data-testid={`tree-node-${node.id}`} />
  }
  return { default: TreeNodeProbe }
})

// 真实 hook 每次渲染都返回新对象（`hooks/useInPlaceEdit.ts:124-138`），mock 保持这一形态：
// `inPlaceEdit` / `inputProps` / 方法都是新引用，但 `inputProps.ref` 与两个 Set 是 state/useRef
// 语义的稳定容器（真实实现亦然）。
vi.mock('../hooks/useNotesEditing', () => {
  const renamingNodeIds = new Set<string>()
  const newlyRenamedNodeIds = new Set<string>()
  const inputRef = { current: null }
  return {
    useNotesEditing: () => ({
      editingNodeId: null,
      renamingNodeIds,
      newlyRenamedNodeIds,
      inPlaceEdit: {
        isEditing: false,
        isSaving: false,
        startEdit: () => {},
        saveEdit: () => {},
        cancelEdit: () => {},
        inputProps: { ref: inputRef, value: '', disabled: false }
      },
      handleStartEdit: () => {},
      handleAutoRename: () => {},
      setEditingNodeId: () => {}
    })
  }
})

vi.mock('../hooks/useNotesMenu', () => {
  // 真实 useNotesMenu 的 getMenuItems 是 useCallback（引用稳定），mock 保持同一语义。
  const getMenuItems = () => []
  return { useNotesMenu: () => ({ getMenuItems }) }
})

vi.mock('../hooks/useNotesDragAndDrop', () => ({
  useNotesDragAndDrop: () => ({
    draggedNodeId: null,
    dragOverNodeId: null,
    dragPosition: null,
    handleDragStart: () => {},
    handleDragOver: () => {},
    handleDragLeave: () => {},
    handleDrop: () => {},
    handleDragEnd: () => {}
  })
}))

vi.mock('../hooks/useNotesFileUpload', () => ({
  useNotesFileUpload: () => ({
    handleDropFiles: () => {},
    handleSelectFiles: () => {},
    handleSelectFolder: () => {}
  })
}))

vi.mock('../hooks/useFullTextSearch', () => ({
  useFullTextSearch: () => ({
    search: harness.search,
    cancel: vi.fn(),
    reset: harness.reset,
    isSearching: harness.state.isSearching,
    results: harness.state.results,
    stats: harness.state.stats,
    error: harness.state.error,
    failedFiles: harness.state.failedFiles,
    failureMessage: harness.state.failureMessage,
    searchedKeyword: harness.state.searchedKeyword
  })
}))

const notesTree = [
  {
    id: 'n1',
    name: 'note-one.md',
    type: 'file' as const,
    treePath: '/n1',
    externalPath: '/notes/n1.md',
    createdAt: '',
    updatedAt: '',
    isStarred: true
  }
]

const sidebarProps = {
  notesTree,
  selectedFolderId: null,
  onCreateFolder: vi.fn(),
  onCreateNote: vi.fn(),
  onSelectNode: vi.fn(),
  onDeleteNode: vi.fn(),
  onRenameNode: vi.fn(),
  onToggleExpanded: vi.fn(),
  onToggleStar: vi.fn(),
  onMoveNode: vi.fn(),
  onSortNodes: vi.fn(),
  onUploadFiles: vi.fn()
}

function openSearchWithKeyword(keyword = 'abc') {
  fireEvent.click(screen.getByTestId('toggle-search'))
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: keyword } })
}

function resetSearchState(overrides: Partial<SearchState> = {}) {
  Object.assign(harness.state, {
    isSearching: false,
    results: [],
    stats: { total: 0, fileNameMatches: 0, contentMatches: 0, bothMatches: 0 },
    error: null,
    failedFiles: 0,
    failureMessage: null,
    searchedKeyword: null,
    ...overrides
  })
}

describe('NotesSidebar · 检索状态面与分片上下文', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.records.length = 0
    resetSearchState()
  })

  it('整库检索失败 ⇒ 错误条 + 重试按钮，且不渲染 0 命中占位', () => {
    resetSearchState({ error: new Error('EACCES: permission denied') })

    render(<NotesSidebar {...sidebarProps} />)
    openSearchWithKeyword()

    expect(screen.getByTestId('notes-search-error')).toBeInTheDocument()
    expect(screen.queryByTestId('notes-search-empty')).toBeNull()

    // 重试按钮真的重发检索（用当前关键词与原树）。
    fireEvent.click(screen.getByTitle('common.retry'))
    expect(harness.search).toHaveBeenCalledWith(notesTree, 'abc')
  })

  it('真 0 命中 ⇒ 显式占位（不是一片空列表）', () => {
    resetSearchState({ searchedKeyword: 'abc' })

    render(<NotesSidebar {...sidebarProps} />)
    openSearchWithKeyword()

    expect(screen.getByTestId('notes-search-empty')).toHaveTextContent('notes.search.no_results')
    expect(screen.queryByTestId('notes-search-error')).toBeNull()
  })

  it('部分文件读取失败 ⇒ 结果之外单独给出"N 个文件读取失败"', () => {
    resetSearchState({
      searchedKeyword: 'abc',
      stats: { total: 2, fileNameMatches: 2, contentMatches: 0, bothMatches: 0 },
      failedFiles: 3,
      failureMessage: 'EBUSY'
    })

    render(<NotesSidebar {...sidebarProps} />)
    openSearchWithKeyword()

    const partial = screen.getByTestId('notes-search-partial-failure')
    expect(partial).toHaveTextContent('notes.search.failed_partial')
    expect(partial.querySelector('span')?.getAttribute('title')).toBe('EBUSY')
    // 有结果时结果数照常显示（不互相顶替）。
    expect(screen.getByText('notes.search.found_results')).toBeInTheDocument()
  })

  it('与上下文无关的状态变化后，editing/actions/ui 三个上下文值引用不变', () => {
    render(<NotesSidebar {...sidebarProps} />)

    const before = harness.records.at(-1)!

    // 收藏视图开关：只改行过滤，不动任何编辑/菜单/下拉状态。
    fireEvent.click(screen.getByTestId('toggle-starred'))

    const after = harness.records.at(-1)!

    expect(after).not.toBe(before) // 确实重渲染了
    expect(after.editing).toBe(before.editing)
    expect(after.actions).toBe(before.actions)
    expect(after.ui).toBe(before.ui)
  })
})
