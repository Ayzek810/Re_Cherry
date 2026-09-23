/**
 * 作曲条（`ComposerSurface`）的键盘交互契约测试。
 *
 * 行为级验证（§4.18）：V2 `components/composer/ComposerSurfaceRuntime.tsx:1503-1512` ——
 * 「提示框为空 + 有附件」时按 Backspace 摘掉最后一个附件并吞掉删除。fork 此前声明了
 * `filesCount` 却不消费它，键盘删除参考图的路径整条不存在（P1）。
 */
import type { FileMetadata } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import ComposerSurface from '../ComposerSurface'

vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelReservedSymbol: { QuickPhrases: 'quick-phrases' },
  QuickPanelView: () => null,
  useQuickPanel: () => ({ open: vi.fn() })
}))

vi.mock('@renderer/services/QuickPhraseService', () => ({
  default: { getAll: vi.fn().mockResolvedValue([]) }
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: { handlePaste: vi.fn() }
}))

const file = (id: string): FileMetadata => ({
  id,
  name: `${id}.png`,
  origin_name: `${id}.png`,
  path: `/tmp/${id}.png`,
  size: 1,
  ext: '.png',
  type: 'image',
  created_at: '',
  count: 1
})

const INITIAL_FILES = [file('a'), file('b')]

/** 受控宿主：files/text 由测试持有，断言与真实作曲条同一份状态。 */
const Host = ({ initialText = '' }: { initialText?: string }) => {
  const [files, setFiles] = useState<FileMetadata[]>(INITIAL_FILES)
  const [text, setText] = useState(initialText)

  return (
    <div>
      <span data-testid="files-count">{files.length}</span>
      <span data-testid="file-ids">{files.map((entry) => entry.id).join(',')}</span>
      <ComposerSurface
        text={text}
        onTextChange={setText}
        tokens={[]}
        managedTokenKinds={[]}
        onTokensChange={vi.fn()}
        placeholder="p"
        sendDisabled
        isLoading={false}
        onSendDraft={vi.fn()}
        onPause={vi.fn()}
        supportedExts={['.png']}
        setFiles={setFiles}
        filesCount={files.length}
        isExpanded={false}
        onExpandedChange={vi.fn()}
        quickPanelEnabled={false}
        enableDragDrop={false}
        enableSpellCheck={false}
        fontSize={14}
        narrowMode={false}
      />
    </div>
  )
}

const textarea = () => screen.getByRole('textbox')

describe('ComposerSurface · Backspace 删最后一个附件', () => {
  it('提示框为空且有附件时，Backspace 摘掉最后一个附件', () => {
    render(<Host />)
    expect(screen.getByTestId('files-count')).toHaveTextContent('2')

    fireEvent.keyDown(textarea(), { key: 'Backspace' })

    expect(screen.getByTestId('files-count')).toHaveTextContent('1')
    expect(screen.getByTestId('file-ids')).toHaveTextContent('a')
  })

  it('提示框只有空白字符时同样摘掉（V2 用 trim() 判空）', () => {
    render(<Host initialText="   " />)

    fireEvent.keyDown(textarea(), { key: 'Backspace' })

    expect(screen.getByTestId('files-count')).toHaveTextContent('1')
  })

  it('提示框有正文时不吞 Backspace（交给 textarea 正常删字）', () => {
    render(<Host initialText="hello" />)

    fireEvent.keyDown(textarea(), { key: 'Backspace' })

    expect(screen.getByTestId('files-count')).toHaveTextContent('2')
  })

  it('没有附件时不接管 Backspace', () => {
    render(<Host />)
    fireEvent.keyDown(textarea(), { key: 'Backspace' })
    fireEvent.keyDown(textarea(), { key: 'Backspace' })
    // 两张都被摘掉后，再按不该出错也不该有负长度
    expect(screen.getByTestId('files-count')).toHaveTextContent('0')
    fireEvent.keyDown(textarea(), { key: 'Backspace' })
    expect(screen.getByTestId('files-count')).toHaveTextContent('0')
  })
})
