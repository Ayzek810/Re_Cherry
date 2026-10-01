/**
 * LocalPaddle 模型仓单元测试（收编自 services/localModel 的 localModel.test.ts）：
 * - modelAssets：双镜像直链形态 + fork 固定顺序（ModelScope 优先）+ minBytes/落盘名/权重健全性；
 * - modelStore.dictTextFromInferenceYml：字典构建的 ppu 兼容格式
 *   （前导空行 + 逐项换行 + 尾换行——ppu 按行 split 不 trim，index 0 = blank）；
 * - modelStore 路径与就绪探测：userData 派生路径 + 三文件齐（electron/fs 均为 main.setup mock）；
 * - modelStore.getStatus 状态机：not_downloaded / ready / unsupported（darwin-x64）；
 * - modelStore.remove：先终止活 OCR 子进程再删盘（Windows 打开句柄会让 unlink 失败）。
 * 下载/推理的运行时行为不在单元面（网络与 onnx 运行时），由 scratch 实证 + 真机验收。
 */
import { existsSync, promises as fsPromises } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { terminateActiveOcrProcess } from '../localOcr'
import { LOCAL_PADDLE_ASSETS, MODEL_SOURCE_ORDER, resolveModelFileUrl } from '../modelAssets'
import {
  dictTextFromInferenceYml,
  isPaddleModelReady,
  localPaddleModelStore,
  paddleModelDir,
  paddleModelPaths
} from '../modelStore'

vi.mock('../localOcr', () => ({
  terminateActiveOcrProcess: vi.fn(async () => {})
}))

// main.setup 的 node:fs mock 缺 promises.rm（本套件 remove 用例需要）——
// 以真实 fs 为底补齐 existsSync 与 rm 的可断言形态；default 同步带上
// （modelStore 走 `import fs from 'node:fs'` 默认导入）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const mock = {
    ...actual,
    existsSync: vi.fn(),
    promises: { ...(actual.promises as object), rm: vi.fn(async () => {}) }
  }
  return { ...mock, default: mock }
})

const mockedExistsSync = vi.mocked(existsSync)

describe('modelAssets（镜像与资产表）', () => {
  it('resolves ModelScope direct URLs with the master revision', () => {
    expect(resolveModelFileUrl('modelscope', 'PaddlePaddle/PP-OCRv6_medium_det_onnx', 'inference.onnx')).toBe(
      'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/master/inference.onnx'
    )
  })

  it('resolves HuggingFace direct URLs with the main revision', () => {
    expect(resolveModelFileUrl('huggingface', 'PaddlePaddle/PP-OCRv6_medium_rec_onnx', 'inference.yml')).toBe(
      'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.yml'
    )
  })

  it('fixes the fork order: ModelScope first, HuggingFace fallback', () => {
    expect(MODEL_SOURCE_ORDER).toEqual(['modelscope', 'huggingface'])
  })

  it('keeps weight minBytes far above LFS pointer size and weights ≈ file MB', () => {
    const { weights, dictionary } = LOCAL_PADDLE_ASSETS
    for (const file of Object.values(weights)) {
      expect(file.minBytes).toBeGreaterThanOrEqual(1_000_000)
      expect(file.weight).toBeGreaterThan(0)
      expect(file.fileName).toMatch(/\.onnx$/)
    }
    expect(dictionary.minBytes).toBeGreaterThanOrEqual(10_000)
    expect(dictionary.fileName).toBe('ppocrv6_dict.txt')
    expect(dictionary.sourceFile).toBe('inference.yml')
  })
})

describe('dictTextFromInferenceYml', () => {
  it('builds the ppu-compatible dict: leading blank line, per-item lines, trailing newline', () => {
    const yml = ['PostProcess:', '  character_dict:', "    - 'a'", "    - 'b'", "    - ' '"].join('\n')
    expect(dictTextFromInferenceYml(yml)).toBe('\na\nb\n \n')
  })

  it('coerces non-string entries and rejects a missing character_dict', () => {
    const numeric = ['PostProcess:', '  character_dict:', '    - 1', '    - 2'].join('\n')
    expect(dictTextFromInferenceYml(numeric)).toBe('\n1\n2\n')
    expect(() => dictTextFromInferenceYml('PostProcess:\n  other: 1')).toThrow(/character_dict/)
    expect(() => dictTextFromInferenceYml('not: a model config')).toThrow(/character_dict/)
  })
})

describe('modelStore 路径与就绪探测（electron app + node:fs mocked by main setup）', () => {
  it('derives the model dir from userData, outside Data/ (not backed up)', () => {
    // node:path 在 vitest builtin 外置下走 setup 的 join（'/' 连接）——断言契约
    //（userData + Runtime/models/pp-ocrv6）而非分隔符风格。
    expect(paddleModelDir()).toMatch(/mock[\\/]userData[\\/]Runtime[\\/]models[\\/]pp-ocrv6$/)
    const paths = paddleModelPaths()
    expect(paths.detection).toContain('PP-OCRv6_medium_det.onnx')
    expect(paths.recognition).toContain('PP-OCRv6_medium_rec.onnx')
    expect(paths.charactersDictionary).toContain('ppocrv6_dict.txt')
  })

  it('is ready only when all three files exist', () => {
    mockedExistsSync.mockReturnValue(true)
    expect(isPaddleModelReady()).toBe(true)
    mockedExistsSync.mockReturnValue(false)
    expect(isPaddleModelReady()).toBe(false)
  })
})

describe('localPaddleModelStore.getStatus', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset()
  })

  it('reports not_downloaded when weights are absent (supported platform)', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(localPaddleModelStore.getStatus().status).toBe('not_downloaded')
  })

  it('reports ready when all three files exist', () => {
    mockedExistsSync.mockReturnValue(true)
    const status = localPaddleModelStore.getStatus()
    expect(status.status).toBe('ready')
    expect(status.percent).toBe(100)
  })

  it('reports unsupported on darwin-x64 (no onnxruntime native binding)', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    const archDesc = Object.getOwnPropertyDescriptor(process, 'arch')
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
      expect(localPaddleModelStore.getStatus().status).toBe('unsupported')
    } finally {
      if (platformDesc) Object.defineProperty(process, 'platform', platformDesc)
      if (archDesc) Object.defineProperty(process, 'arch', archDesc)
    }
  })
})

describe('localPaddleModelStore.remove（删除前置终止子进程）', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset()
    vi.clearAllMocks()
  })

  it('terminates the active OCR process before removing the model dir (Windows handle lock)', async () => {
    const rmSpy = vi.mocked(fsPromises.rm)
    await localPaddleModelStore.remove()
    expect(vi.mocked(terminateActiveOcrProcess)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(terminateActiveOcrProcess).mock.invocationCallOrder[0]).toBeLessThan(
      rmSpy.mock.invocationCallOrder[0]
    )
    expect(rmSpy).toHaveBeenCalledWith(
      expect.stringContaining('pp-ocrv6'),
      expect.objectContaining({ recursive: true, force: true })
    )
  })
})
