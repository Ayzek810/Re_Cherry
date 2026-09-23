/**
 * guard 反馈出口（v0.3.3 批次4，② 薄适配）：V2 toast/modal → window.toast /
 * antd Modal（window.modal.confirm）。四类 reason 的文案键保留。
 */
import i18n from '@renderer/i18n'
import { createPaintingGenerateError, presentPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import type { PaintingGenerationGuardReason } from '@renderer/pages/paintings/hooks/usePaintingGenerationGuard'

function openProviderSettings(providerId: string) {
  window.navigate(`/settings/provider?id=${encodeURIComponent(providerId)}`)
}

export async function presentPaintingGenerationGuardFeedback(
  reason: PaintingGenerationGuardReason,
  error?: Error,
  providerId?: string
) {
  if (reason === 'provider_disabled') {
    if (providerId) {
      const confirmed = await new Promise<boolean>((resolve) => {
        window.modal.confirm({
          title: i18n.t('error.provider_disabled'),
          okText: i18n.t('common.go_to_settings'),
          cancelText: i18n.t('common.cancel'),
          centered: true,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
      if (confirmed) {
        openProviderSettings(providerId)
      }
      return
    }
    presentPaintingGenerateError(createPaintingGenerateError('PROVIDER_DISABLED'))
    return
  }
  if (reason === 'catalog_error') {
    window.toast.error(error?.message || i18n.t('paintings.req_error_model'))
    return
  }
  if (reason === 'model_unavailable') {
    window.toast.error(i18n.t('paintings.req_error_model'))
    return
  }
  // fork 缝：A4 —— 这里落到 `model_missing`（既无 provider 启停问题、模型目录也同步可读）。V2 原文
  // （V2:43）用的是**按钮标签键** `paintings.select_model`（zh"选择绘画模型"），当错误说明读出来是
  // 一句按钮名、不是原因；改用既有的说明键 `paintings.req_error_model`（zh"请先在设置中选择绘画模型"，
  // 与 model_unavailable 分支同键）。不新增 locale 键，故无需 i18n:sync。
  window.toast.error(i18n.t('paintings.req_error_model'))
}
