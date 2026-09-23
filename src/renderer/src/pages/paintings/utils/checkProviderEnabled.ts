/**
 * provider 启用检查（v0.3.3 批次4，② 薄适配）：fork provider.enabled 判断 +
 * antd Modal 确认跳 /settings（react-router navigate 经 window.navigate）。
 * V2 popup.warning → window.modal.confirm。
 */
import i18n from '@renderer/i18n'
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
    throw 'Provider disabled'
  }

  // Keyless-permissive: return whatever key exists (possibly empty) and let the
  // request fail naturally if the provider requires one — consistent with chat/agent.
  return provider.apiKey ?? ''
}
