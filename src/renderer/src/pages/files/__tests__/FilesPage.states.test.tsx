/**
 * 二轮审查 f2-42：文件页首帧加载态被渲染成"空数据"。
 *
 * `useLiveQuery` 在首个结果到达前返回 `undefined`（= 加载中），与"查到了 0 行"是两件事。
 * 旧实现两者都落到 `Empty`：每次进入文件页先闪一下"暂无数据"（§9「Show a skeleton or a
 * placeholder for every state」）。
 *
 * 二轮审查 f2-41：`dataSource` 的 map 里每行一条 `logger.debug('FileItem', file)`——纯脚手架
 * 语句，文件多时既刷屏又白做功。
 */
import { loggerService } from '@logger'
import store from '@renderer/store'
import type { FileMetadata } from '@renderer/types'
import { render, screen } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FilesPage from '../FilesPage'

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: vi.fn() }))

vi.mock('@renderer/databases', () => ({ default: { files: {} } }))

vi.mock('@renderer/i18n/label', () => ({ getFileFieldLabel: (field: string) => field }))

vi.mock('@renderer/services/FileAction', () => ({
  handleDelete: vi.fn(),
  handleRename: vi.fn(),
  sortFiles: (files: FileMetadata[]) => files,
  tempFilesSort: (files: FileMetadata[]) => files
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getFile: vi.fn(),
    getFilePath: (file: FileMetadata) => `/files/${file.id}`,
    formatFileName: (file: FileMetadata) => file.origin_name
  }
}))

vi.mock('../FileList', () => ({
  default: () => <div data-testid="file-list" />
}))

// 只测页面主体的状态面：导航栏自带全屏/背景色等宿主依赖，与本条无关。
vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  NavbarCenter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

const useLiveQueryMock = vi.mocked(useLiveQuery)

function makeFile(index: number): FileMetadata {
  return {
    id: `file-${index}`,
    origin_name: `doc-${index}.md`,
    name: `file-${index}.md`,
    path: `/files/file-${index}.md`,
    ext: '.md',
    type: 'document',
    size: 2048,
    count: 1,
    created_at: '2026-01-01T00:00:00.000Z'
  } as unknown as FileMetadata
}

const renderPage = () =>
  render(
    <Provider store={store}>
      <FilesPage />
    </Provider>
  )

describe('FilesPage · 首帧状态与渲染期日志', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // antd 的部分组件（响应式栅格/Modal）需要 matchMedia，jsdom 不提供。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  it('f2-42：加载中画占位（不是 Empty），查到 0 行才画 Empty', () => {
    useLiveQueryMock.mockReturnValue(undefined as never)

    const { rerender, container } = renderPage()

    expect(screen.getByTestId('files-loading')).toBeInTheDocument()
    expect(container.querySelector('.ant-empty')).toBeNull()
    expect(screen.queryByTestId('file-list')).toBeNull()

    // 查询返回空数组 = 确定性答案"该分类下没有文件"。
    useLiveQueryMock.mockReturnValue([] as never)
    rerender(
      <Provider store={store}>
        <FilesPage />
      </Provider>
    )

    expect(screen.queryByTestId('files-loading')).toBeNull()
    expect(container.querySelector('.ant-empty')).not.toBeNull()
  })

  it('f2-42：有数据时渲染列表，既不画加载占位也不画 Empty', () => {
    useLiveQueryMock.mockReturnValue([makeFile(1), makeFile(2)] as never)

    const { container } = renderPage()

    expect(screen.getByTestId('file-list')).toBeInTheDocument()
    expect(screen.queryByTestId('files-loading')).toBeNull()
    expect(container.querySelector('.ant-empty')).toBeNull()
  })

  it('f2-41：渲染路径里不再逐行打 debug 日志', () => {
    const debug = vi.spyOn(loggerService, 'debug').mockImplementation(() => {})
    useLiveQueryMock.mockReturnValue([makeFile(1), makeFile(2), makeFile(3)] as never)

    renderPage()

    expect(debug).not.toHaveBeenCalledWith('FileItem', expect.anything())
    debug.mockRestore()
  })
})
