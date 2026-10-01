/**
 * provider 启用检查（② 薄适配）：fork provider.enabled 判断 +
 * antd Modal 确认跳 /settings（react-router navigate 经 window.navigate）。
 * V2 popup.warning → window.modal.confirm。
 */
import i18n from '@renderer/i18n'
import { createPaintingGenerateError } from '@renderer/pages/paintings/errors/paintingGenerateError'
import type { Provider } from '@renderer/types'

function navigateToProviderSettings(providerId: string) {
  window.navigate(`/settings/provider?id=${encodeURIComponent(providerId)}`)
}

export async function checkProviderEnabled(provider: Provider): Promise<string> {
  if (!provider.enabled) {
    const confirmed = await new Promise<boolean>((resolve) => {
      window.modal.confirm({
        title: i18n.t('error.provider_disabled'),
        content: provider.name,
        okText: i18n.t('common.go_to_settings'),
        cancelText: i18n.t('common.cancel'),
        centered: true,
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    if (confirmed) {
      navigateToProviderSettings(provider.id)
    }
    // 这里曾 `throw 'Provider disabled'`（裸字符串）。非 Error 抛出会丢栈，
    // `runPainting` 的 `logger.error` 分支不执行（要求失败留痕），
    // `normalizePaintingGenerateError` 也识别不了 → 退化成 `GENERATE_FAILED`，用户先看到
    // `error.provider_disabled` 确认框、紧接着又看到一个无信息量的"生成失败"弹窗。
    // 改为既有分类里的 PROVIDER_DISABLED；上面已确认/跳转过设置，故用 toast 呈现，避免叠一个 modal。
    throw createPaintingGenerateError('PROVIDER_DISABLED', {
      message: i18n.t('error.provider_disabled'),
      presentation: 'toast',
      severity: 'warning'
    })
  }

  // Keyless-permissive: return whatever key exists (possibly empty) and let the
  // request fail naturally if the provider requires one — consistent with chat/agent.
  return provider.apiKey ?? ''
}
