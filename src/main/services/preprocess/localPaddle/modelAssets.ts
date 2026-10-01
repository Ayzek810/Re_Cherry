/**
 * LocalPaddle 模型资产表（收编：自 services/localModel 的
 * localModelCatalog + modelSource 两文件合并为文档处理通道的本地条目数据层）。
 *
 * 数据 only：抓什么（PP-OCRv6_medium 检测/识别权重 + 识别仓 inference.yml 里的
 * 字符字典）；从哪抓（镜像直链解析）。下载落盘/状态机在 modelStore，推理在
 * localOcr / localOcrWorker——本文件不 import electron。
 *
 * 模型身份（PaddlePaddle 官方 ONNX 导出仓）与 minBytes 守门逐字节继承
 * 移植时的实证形态：ModelScope 三直链 Range 探测 + 真模型端到端识别
 * （tools/scratch-verify probe A/B，2026-09-27 复验全绿）。
 */

/** 从 HuggingFace/ModelScope 仓库抓取的模型权重文件。 */
export interface RemoteModelFile {
  /** 仓库 id（下载时按镜像表解析成完整 URL）。 */
  repo: string
  /** 仓库内文件名。 */
  remoteFile: string
  /** 落盘文件名（模型目录下）。 */
  fileName: string
  /** 小于此字节数判失败（LFS 指针 ~132B；错误页更小）。 */
  minBytes: number
  /** 聚合进度条的相对权重（≈ 文件 MB）。 */
  weight: number
}

export interface LocalPaddleAssets {
  weights: { detection: RemoteModelFile; recognition: RemoteModelFile }
  /** 字符字典：*_onnx 仓不单独发布，嵌在识别模型的 inference.yml（PostProcess.character_dict）里。 */
  dictionary: { repo: string; sourceFile: string; fileName: string; minBytes: number }
}

export const LOCAL_PADDLE_ASSETS: LocalPaddleAssets = {
  /** PaddleOCR PP-OCRv6 medium：检测 + 识别权重，外加从 inference.yml 解析出的字典。 */
  weights: {
    detection: {
      repo: 'PaddlePaddle/PP-OCRv6_medium_det_onnx',
      remoteFile: 'inference.onnx',
      fileName: 'PP-OCRv6_medium_det.onnx',
      minBytes: 1_000_000,
      weight: 59
    },
    recognition: {
      repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx',
      remoteFile: 'inference.onnx',
      fileName: 'PP-OCRv6_medium_rec.onnx',
      minBytes: 1_000_000,
      weight: 73
    }
  },
  dictionary: {
    repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx',
    sourceFile: 'inference.yml',
    fileName: 'ppocrv6_dict.txt',
    /** 整份 yml 数万字节（数千字典项 + 模型配置）；过小 = LFS 指针/截断/错误页。 */
    minBytes: 10_000
  }
}

export type ModelSourceId = 'huggingface' | 'modelscope'

const SOURCES: Record<ModelSourceId, { remoteHost: string; remotePathTemplate: string; revision: string }> = {
  huggingface: {
    remoteHost: 'https://huggingface.co',
    remotePathTemplate: '{model}/resolve/{revision}',
    revision: 'main'
  },
  modelscope: {
    remoteHost: 'https://www.modelscope.cn',
    remotePathTemplate: 'models/{model}/resolve/{revision}',
    revision: 'master'
  }
}

/** 镜像尝试顺序（fork 固定）：ModelScope 在前（个人 fork 主用户在国内，HF 直连不可达时零等待降级），HF 兜底。 */
export const MODEL_SOURCE_ORDER: readonly ModelSourceId[] = ['modelscope', 'huggingface']

/** `<repo>/<file>` 在指定镜像上的直链。 */
export function resolveModelFileUrl(id: ModelSourceId, repo: string, file: string): string {
  const source = SOURCES[id]
  const repoPath = source.remotePathTemplate.replace('{model}', repo).replace('{revision}', source.revision)
  return `${source.remoteHost}/${repoPath}/${file}`
}
