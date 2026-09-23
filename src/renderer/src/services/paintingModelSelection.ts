/**
 * 绘画页 provider/模型选择模块（v0.3.3 批次4，fork 侧新写薄适配层）：
 * feature 目录不直接 import config/models 内部——在此消化 isGenerateImageModel
 * 判定（vision.ts L200-218），对外只暴露图像生成模型选择器。
 */
import { isGenerateImageModel, isPureGenerateImageModel } from '@renderer/config/models'
import type { Model, Provider } from '@renderer/types'

/** 全部已启用 provider 的图像生成模型（对话式 + 专用，绘画页模型选择器数据源）。 */
export function selectImageGenerationModels(providers: Provider[]): Model[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.models)
    .filter((model) => isGenerateImageModel(model))
}

/** 纯生图模型（无 function-calling，走 /images/generations 端点的专用模型）。 */
export function selectPureImageGenerationModels(providers: Provider[]): Model[] {
  return selectImageGenerationModels(providers).filter((model) => isPureGenerateImageModel(model))
}

/** 模型是否为编辑模式输入（图生图）：对话式生图模型支持参考图输入。 */
export function supportsPaintingEdit(model: Model | undefined): boolean {
  return model !== undefined && isGenerateImageModel(model) && !isPureGenerateImageModel(model)
}
