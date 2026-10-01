/**
 * 自定义小程序 logo 上传：`FileReader` 的失败必须是**用户可见的信号**。
 *
 * 为什么单独守这条：`FileReader` 的失败是**异步事件**，外层 `try/catch` 捕获不到。只挂
 * `onload` 时，"读不出来"与"用户没选文件"完全同形（既不成功也不报错），保存后得到一个小程序
 * 却没有图标。错误臂（`onerror`）与中止臂（`onabort`）都必须给出错误提示，且不得报成功。
 *
 * 观察窗：替身 `Upload` 直接把一条 `fileList` 喂给组件的 `onChange`（antd 的真实实现里
 * `originFileObj` 在 jsdom 下不落地），`FileReader` 也用替身，由测试显式触发 `onerror` /
 * `onabort`。断言只取用户可见结果（toast），不碰实现细节。
 */
import '@renderer/i18n'

import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/minapps', () => ({
  loadCustomMiniApp: vi.fn().mockResolvedValue([]),
  updateAllMinApps: vi.fn(),
  ORIGIN_DEFAULT_MIN_APPS: []
}))

vi.mock('@renderer/hooks/useMinapps', () => ({
  useMinapps: () => ({ minapps: [], updateMinapps: vi.fn() })
}))

type UploadProps = {
  onChange?: (info: { fileList: unknown[] }) => void
  children?: ReactNode
}

vi.mock('antd', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    Modal: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
    Upload: ({ onChange, children }: UploadProps) => (
      <div>
        {children}
        <button
          type="button"
          data-testid="pick-file"
          onClick={() => onChange?.({ fileList: [{ uid: '1', originFileObj: selectedFile }] })}
        />
      </div>
    )
  }
})

import NewAppButton from '../NewAppButton'

// antd（Modal/Upload/Radio）会读 `window.matchMedia`，jsdom 没有实现。
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
}

/** 替身 FileReader：把 `error`/`abort` 事件交回测试手里。 */
class FakeFileReader {
  static last: FakeFileReader | null = null
  onload: ((event: { target: { result: string } }) => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: { name: string; message: string } | null = { name: 'NotReadableError', message: 'cannot read' }

  constructor() {
    FakeFileReader.last = this
  }

  readAsDataURL() {
    // 不自动触发任何事件：由测试显式调用 `onerror`。
  }
}

const selectedFile = new File(['logo'], 'logo.png', { type: 'image/png' })
const toastError = vi.fn()
const toastSuccess = vi.fn()

describe('NewAppButton logo 上传失败信号', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    toastError.mockReset()
    toastSuccess.mockReset()
    FakeFileReader.last = null
    ;(window as unknown as { toast: unknown }).toast = {
      error: toastError,
      success: toastSuccess,
      warning: vi.fn(),
      info: vi.fn()
    }
    vi.stubGlobal('FileReader', FakeFileReader)
  })

  /** 打开"自定义小程序"弹窗 → 切到"上传 Logo 文件" → 选一个文件（替身 FileReader 已就位）。 */
  const openLogoPicker = (): void => {
    render(<NewAppButton />)
    fireEvent.click(screen.getByText('Custom'))
    fireEvent.click(screen.getByText('Upload Logo File'))
    // 弹窗与单选组用的是真实 antd 组件，这里确认切到了文件分支。
    expect(document.querySelector('input[type="radio"]')).not.toBeNull()
    expect(screen.getByText('Upload')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pick-file'))
    expect(FakeFileReader.last).not.toBeNull()
  }

  it('异步读取失败（onerror）：必须给出用户可见的错误信号', () => {
    openLogoPicker()

    // 缺了 onerror 时这一步什么都不会发生，用户看不到任何提示。
    expect(FakeFileReader.last?.onerror).toBeTypeOf('function')
    FakeFileReader.last!.onerror!()

    expect(toastError).toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('读取被中止（onabort）：同样必须给出错误信号，且不得报成功', () => {
    openLogoPicker()

    expect(FakeFileReader.last?.onabort).toBeTypeOf('function')
    FakeFileReader.last!.onabort!()

    expect(toastError).toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
