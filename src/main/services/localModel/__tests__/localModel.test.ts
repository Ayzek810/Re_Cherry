/**
 * LocalPaddle 本地模型子系统单元测试（v0.3.2）：
 * - modelSource：双镜像直链形态 + fork 固定顺序（ModelScope 优先）；
 * - localModelCatalog：minBytes/落盘名/权重健全性（下载守门的真相源）；
 * - localModelService.dictTextFromInferenceYml：字典构建的 ppu 兼容格式
 *   （前导空行 + 逐项换行 + 尾换行——ppu 按行 split 不 trim，index 0 = blank）；
 * - ocrPaths：userData 派生路径 + 三文件就绪探测（electron/fs 均为 main.setup mock）；
 * - isPlatformSupported：darwin-x64 永不支持（onnxruntime-node 无原生绑定）。
 * 下载/推理的运行时行为不在单元面（网络与 onnx 运行时），由 scratch 实证 + 真机验收。
 */
import { existsSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_MODELS } from '../localModelCatalog'
import { dictTextFromInferenceYml, localModelService } from '../localModelService'
import { MODEL_SOURCE_ORDER, resolveModelFileUrl } from '../modelSource'
import { isLocalOcrModelDownloaded, ocrModelDir, ocrModelPaths } from '../ocrPaths'

const mockedExistsSync = vi.mocked(existsSync)

describe('modelSource', () => {
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
})

describe('localModelCatalog', () => {
  it('keeps weight minBytes far above LFS pointer size and weights ≈ file MB', () => {
    const { weights, dictionary } = LOCAL_MODELS.ocr
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

describe('ocrPaths (electron app + node:fs mocked by main setup)', () => {
  it('derives the model dir from userData, outside Data/ (not backed up)', () => {
    // node:path 在 vitest builtin 外置下走真实实现（win32 join 归一分隔符）——
    // 断言契约（userData + Runtime/models/pp-ocrv6）而非分隔符风格。
    expect(ocrModelDir()).toMatch(/[\\/]mock[\\/]userData[\\/]Runtime[\\/]models[\\/]pp-ocrv6$/)
    const paths = ocrModelPaths()
    expect(paths.detection).toContain('PP-OCRv6_medium_det.onnx')
    expect(paths.recognition).toContain('PP-OCRv6_medium_rec.onnx')
    expect(paths.charactersDictionary).toContain('ppocrv6_dict.txt')
  })

  it('is ready only when all three files exist', () => {
    mockedExistsSync.mockReturnValue(true)
    expect(isLocalOcrModelDownloaded()).toBe(true)
    mockedExistsSync.mockReturnValue(false)
    expect(isLocalOcrModelDownloaded()).toBe(false)
  })
})

describe('localModelService.getStatus', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset()
  })

  it('reports not_downloaded when weights are absent (supported platform)', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(localModelService.getStatus().status).toBe('not_downloaded')
  })

  it('reports ready when all three files exist', () => {
    mockedExistsSync.mockReturnValue(true)
    const status = localModelService.getStatus()
    expect(status.status).toBe('ready')
    expect(status.percent).toBe(100)
  })

  it('reports unsupported on darwin-x64 (no onnxruntime native binding)', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    const archDesc = Object.getOwnPropertyDescriptor(process, 'arch')
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
      expect(localModelService.getStatus().status).toBe('unsupported')
    } finally {
      if (platformDesc) Object.defineProperty(process, 'platform', platformDesc)
      if (archDesc) Object.defineProperty(process, 'arch', archDesc)
    }
  })
})
