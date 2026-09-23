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
  window.toast.error(i18n.t('paintings.select_model'))
}
