import '@renderer/i18n'

import type { MCPServer } from '@renderer/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * JSON 编辑器保存路径（v1 二轮审查 s2-23 / s2-24）。
 *
 * s2-24：守卫写成 `if (parseJSON === null)`——比较的是导入的函数而非解析结果，恒为 false，
 * 于是语法错误带着 `null` 进入 zod 校验，用户看到的是 "expected object, received null"。
 * s2-23：清空编辑器再确定 = 无确认地删掉所有服务器，且绕过 `mcpApi.removeServer`
 *（主进程关客户端 + DXT 解包目录清理），磁盘上的 DXT 目录泄漏。
 */

const mocks = vi.hoisted(() => ({
  servers: [] as MCPServer[],
  dispatch: vi.fn(),
  removeServer: vi.fn(),
  modalConfirm: vi.fn()
}))

const topViewMock = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }))

vi.mock('@renderer/components/TopView', () => ({ TopView: topViewMock }))
vi.mock('@renderer/components/CodeEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea data-testid="json-editor" value={value} onChange={(event) => onChange(event.target.value)} />
  )
}))
vi.mock('@renderer/store', () => ({
  useAppSelector: () => mocks.servers,
  useAppDispatch: () => mocks.dispatch
}))
vi.mock('@renderer/services/mcpApi', () => ({ mcpApi: { removeServer: mocks.removeServer } }))
// 组件只从 '@renderer/utils' 取 parseJSON（语义即「解析失败返回 null」，见 utils/json.ts），
// 这里直接给出等价实现：避免 importOriginal 拉起整个 utils barrel（收集阶段极慢）。
vi.mock('@renderer/utils', () => ({
  modalConfirm: mocks.modalConfirm,
  parseJSON: (text: string) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
}))

import EditMcpJsonPopup from '../EditMcpJsonPopup'

const server = (id: string): MCPServer => ({ id, name: id, isActive: false }) as unknown as MCPServer

/**
 * `show()` 把元素交给 TopView.show —— 取回它自己渲染。
 * 注意：不要 await 返回的弹窗 promise（它只在弹窗关闭后才 settle）。
 */
const openPopup = () => {
  const promise = EditMcpJsonPopup.show()
  const element = topViewMock.show.mock.calls.at(-1)?.[0] as React.ReactElement
  render(element)
  return promise
}

const clickOk = () => fireEvent.click(document.querySelector('.ant-btn-primary') as HTMLButtonElement)

beforeEach(() => {
  mocks.servers = [server('a'), server('b')]
  mocks.dispatch.mockReset()
  mocks.removeServer.mockReset()
  mocks.removeServer.mockResolvedValue(undefined)
  mocks.modalConfirm.mockReset()
  mocks.modalConfirm.mockResolvedValue(true)
  topViewMock.show.mockClear()
  window.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } as unknown as typeof window.toast
})

describe('EditMcpJsonPopup 的保存', () => {
  it('语法错误报「导入格式无效」，不是 zod 的 expected object', async () => {
    void openPopup()

    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '{ not json' } })
    clickOk()

    await waitFor(() => expect(screen.getByText(/导入格式无效|Invalid import format|invalid/i)).toBeInTheDocument())
    expect(screen.queryByText(/expected object/i)).toBeNull()
  })

  it('清空编辑器保存会先确认，取消则什么都不做', async () => {
    mocks.modalConfirm.mockResolvedValue(false)

    void openPopup()
    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '   ' } })
    clickOk()

    await waitFor(() => expect(mocks.modalConfirm).toHaveBeenCalled())
    expect(mocks.removeServer).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('确认后逐个走 removeServer（清理 DXT 目录），再整体落库', async () => {
    void openPopup()
    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '' } })
    clickOk()

    await waitFor(() => expect(mocks.removeServer).toHaveBeenCalledTimes(2))
    expect(mocks.removeServer.mock.calls[0][0]).toMatchObject({ id: 'a' })
    expect(mocks.removeServer.mock.calls[1][0]).toMatchObject({ id: 'b' })
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: [] }))
    expect(window.toast.success).toHaveBeenCalled()
  })

  it('删除失败时报「N 成功 / M 失败」，不是纯成功', async () => {
    mocks.removeServer.mockRejectedValueOnce(new Error('ipc down'))

    void openPopup()
    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '' } })
    clickOk()

    await waitFor(() => expect(window.toast.warning).toHaveBeenCalled())
    expect(window.toast.success).not.toHaveBeenCalled()
    // 失败的那条仍要报告，成功的另一条照样落库
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: [] }))
  })
})
