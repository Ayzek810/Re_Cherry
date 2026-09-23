/**
 * 绘画页 provider/模型选择模块（v0.3.3 批次4，fork 侧新写薄适配层；v0.3.3-18 判据收敛）：
 * feature 目录不直接 import config/models 内部——在此消化 `isGenerateImageModel`
 * （生图场景的唯一判据，数据来源见 vision.ts 注释），对外只暴露图像生成模型选择器。
 */
import { isGenerateImageModel, isVisionModel } from '@renderer/config/models'
import type { Model, Provider } from '@renderer/types'

/** 全部已启用 provider 的图像生成模型（绘画页模型选择器数据源 = 生图判据本身）。 */
export function selectImageGenerationModels(providers: Provider[]): Model[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.models)
    .filter((model) => isGenerateImageModel(model))
}

/**
 * 可生图谓词（单一来源）：`selectImageGenerationModels` 的逐模型二值形式，
 * 供选择器 filter / ModelSelector predicate 复用，避免各处自造同义判定。
 */
export function isPaintingCandidateModel(model: Model): boolean {
  return isGenerateImageModel(model)
}

/**
 * 模型是否为编辑模式输入（图生图）。
 *
 * V2 对应物是 `isEditImageModel = IMAGE_GENERATION && 输入模态含 image`
 * （`cherry-studio v2/src/shared/utils/model.ts:62-63`）；fork 没有 `inputModalities`，
 * 故用 `isVisionModel`（能读图）作为"能收参考图"的等价判据。
 */
export function supportsPaintingEdit(model: Model | undefined): boolean {
  return model !== undefined && isGenerateImageModel(model) && isVisionModel(model)
}
