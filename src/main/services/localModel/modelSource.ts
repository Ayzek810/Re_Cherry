/**
 * 本地模型下载镜像（v0.3.2 自 CS_V2 移植；fork 裁剪：无 RegionService 出口 IP
 * 探测，固定 ModelScope 优先——个人 fork 主用户在国内，HF 直连不可达时零等待
 * 降级；两镜像逐文件回退的语义与上游一致）。
 */

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

/** 镜像尝试顺序（fork 固定）：区域默认在前，另一个兜底。 */
export const MODEL_SOURCE_ORDER: readonly ModelSourceId[] = ['modelscope', 'huggingface']

/** `<repo>/<file>` 在指定镜像上的直链。 */
export function resolveModelFileUrl(id: ModelSourceId, repo: string, file: string): string {
  const source = SOURCES[id]
  const repoPath = source.remotePathTemplate.replace('{model}', repo).replace('{revision}', source.revision)
  return `${source.remoteHost}/${repoPath}/${file}`
}
