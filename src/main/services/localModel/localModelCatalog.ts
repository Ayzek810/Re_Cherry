/**
 * 本地模型目录（v0.3.2 自 CS_V2 移植，fork 裁剪：仅 OCR——本地嵌入模型不在本批范围）。
 * 数据 only：抓什么；从哪抓的镜像解析见 modelSource.ts，行为在 localModelService /
 * ocrInferenceService。盘上路径派生见 ocrPaths.ts。
 */

/** 从 HuggingFace/ModelScope 仓库抓取的模型文件。 */
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

export const LOCAL_MODELS = {
  /** PaddleOCR PP-OCRv6 medium：检测 + 识别权重，外加从 inference.yml 解析出的字典。 */
  ocr: {
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
    /**
     * 字符字典：*_onnx 仓库不单独发布，嵌在识别模型的 inference.yml
     * （PostProcess.character_dict）里——下载服务抓 yml 解析后落盘。
     */
    dictionary: {
      repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx',
      sourceFile: 'inference.yml',
      fileName: 'ppocrv6_dict.txt',
      /** 整份 yml 数万字节（数千字典项 + 模型配置）；过小 = LFS 指针/截断/错误页。 */
      minBytes: 10_000
    }
  }
}
