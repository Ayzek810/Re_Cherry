/**
 * 生成完成时用「提交瞬间的快照」整体覆盖当前草稿。
 *
 * 缺陷形态：成功路径 `applyIfVisible({ ...targetPainting, files: generatedFiles })`，
 * `targetPainting` 是 `generate()` 入口处的闭包快照；而生成期间输入框、模型选择器、参数
 * Popover 都没有被 disable，用户改的 prompt / 参数 / 模型会在完成时被静默回滚——用户看到
 * 「自己刚打的字没了」，且画面用的还是提交时的提示词。
 *
 * 行为级断言（真 hook、真 React 状态推进，只替身 IO 边界）：
 *   ① 生成期间把 painting 换成「用户改过 prompt 的同一幅」，完成后 `onPaintingChange` 的
 *      最后一笔必须带上**新 prompt**（旧实现是提交时的旧 prompt）；
 *   ② 同一笔必须带上新生成的 files，且 generationStatus/generationError 被清空；
 *   ③ 会话镜像那笔（提交时的 prompt）与最终笔的 prompt 不同——证明覆盖确实发生过。
 */
import type { FileMetadata } from '@renderer/types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { paintingGenerate, resolvePaintingFiles, setGenerationState, mockPresent } = vi.hoisted(() => ({
  paintingGenerate: vi.fn(),
  // 显式返回类型：`vi.fn(async () => [])` 会把 resolve 值推成 `never[]`，
  // `mockResolvedValueOnce([file('y')])` 随即报 TS2322。
  resolvePaintingFiles: vi.fn<() => Promise<FileMetadata[]>>(async () => []),
  setGenerationState: vi.fn(),
  mockPresent: vi.fn()
}))

vi.mock('@renderer/databases', () => ({
  db: {
    paintings: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined)
    }
  }
}))

vi.mock('@renderer/pages/paintings/context/PaintingSessionContext', () => ({
  usePaintingSession: () => ({ setGenerationState })
}))

vi.mock('@renderer/pages/paintings/model/paintingPipeline', () => ({
  paintingGenerate
}))

vi.mock('@renderer/pages/paintings/errors/paintingGenerateError', () => ({
  presentPaintingGenerateError: mockPresent
}))

vi.mock('@renderer/pages/paintings/model/mappers/paintingRecordMappers', () => ({
  paintingDataToRecord: (painting: { id: string }) => ({ id: painting.id, createdAt: 1 })
}))

vi.mock('@renderer/pages/paintings/model/paintingAbortControllerStore', () => ({
  abortPaintingGeneration: vi.fn(),
  clearPaintingAbortController: vi.fn(),
  getPaintingAbortController: vi.fn(() => null),
  registerPaintingAbortController: vi.fn()
}))

vi.mock('@renderer/pages/paintings/model/runPainting', () => ({
  // Mirror the real `runPainting` contract: run the generator, then turn its
  // result into FileMetadata[] (the real one resolves files; the test only needs
  // the sequencing + the file payload).
  runPainting: async (generate: () => Promise<unknown>) => {
    await generate()
    return resolvePaintingFiles()
  }
}))

vi.mock('@renderer/services/lightLlm', () => ({
  lightImageAbort: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: () => [{ id: 'p1', name: 'Provider One', enabled: true, apiKey: 'k', models: [] }]
}))

import type { PaintingData } from '../../model/types/paintingData'
import { usePaintingGeneration } from '../usePaintingGeneration'

const file = (id: string): FileMetadata =>
  ({ id, name: `${id}.png`, origin_name: `${id}.png`, ext: '.png', type: 'image' }) as FileMetadata

const SUBMITTED: PaintingData = {
  id: 'painting-1',
  providerId: 'p1',
  mode: 'generate',
  model: 'm1',
  prompt: 'old prompt',
  files: [],
  inputFiles: [],
  params: { size: '1024x1024' }
}

/** The draft as the user left it while the run was in flight. */
const EDITED_WHILE_RUNNING: PaintingData = {
  ...SUBMITTED,
  prompt: 'edited while generating',
  params: { size: '512x512' }
}

describe('usePaintingGeneration 生成完成只并 files', () => {
  it('完成时保留生成期间的编辑，只并入新文件', async () => {
    let resolveGenerate: (value: unknown) => void = () => {}
    paintingGenerate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGenerate = resolve
        })
    )
    resolvePaintingFiles.mockResolvedValueOnce([file('y')])

    const onPaintingChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ painting }: { painting: PaintingData }) => usePaintingGeneration({ painting, onPaintingChange }),
      { initialProps: { painting: SUBMITTED } }
    )

    let submission: Promise<void> = Promise.resolve()
    await act(async () => {
      submission = result.current.generate([])
    })

    // 用户仍在编辑：同一幅画，prompt/参数已改。
    rerender({ painting: EDITED_WHILE_RUNNING })

    await act(async () => {
      resolveGenerate({ type: 'base64', images: ['y'] })
      await submission
    })

    await waitFor(() => {
      const completion = onPaintingChange.mock.calls.at(-1)?.[0] as PaintingData | undefined
      expect(completion?.files).toHaveLength(1)
    })

    const completion = onPaintingChange.mock.calls.at(-1)?.[0] as PaintingData
    // ① 生成期间的编辑没有被提交时的快照回滚。
    expect(completion.prompt).toBe('edited while generating')
    expect(completion.params).toEqual({ size: '512x512' })
    // ② 新文件并入，生成态清干净。
    expect(completion.files.map((f) => f.id)).toEqual(['y'])
    expect(completion.generationStatus).toBeNull()
    expect(completion.generationError).toBeNull()
    // ③ 会话镜像那一笔带的是提交时的 prompt —— 覆盖确实发生过（否则本用例无意义）。
    expect(onPaintingChange.mock.calls[0][0].prompt).toBe('old prompt')
    expect(mockPresent).not.toHaveBeenCalled()
  })
})
