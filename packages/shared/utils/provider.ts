// fork 缝：V2 Provider 类型未整体移植，此处为函数面所需最小结构（isLoginBasedProvider）。
// 函数体逐字取自 V2 src/shared/utils/provider.ts；authMethods 在 V2 为
// ('api-key' | 'oauth' | 'external-cli')[] 可选字段，fork 的 KernelProviderInput 无该字段
// ——缺省即按 V2 "Absent ⇒ default ['api-key'] ⇒ not login-based" 语义返回 false。

/**
 * Login-based providers authenticate via a sign-in flow (CLI login / hosted
 * OAuth) and accept no user API key, so the generic API-key/host UI is
 * suppressed and their sign-in panel renders through the provider registry
 * instead. Derived from the provider's `authMethods` (registry capability):
 * login-based ⇔ it declares methods and none is `'api-key'`. Absent ⇒ default
 * `['api-key']` ⇒ not login-based. CherryIN declares `['api-key', 'oauth']`, so
 * it is *not* login-based — its key inputs stay alongside the OAuth panel.
 */
// fork 缝：V2 原文参数为 Pick<Provider, 'authMethods'>；此处为最小结构类型，id?: string
// 仅为通过 TS weak-type 检查（调用方 KernelProviderInput 无 authMethods，需一个重叠属性），
// 函数体不读取它。
export function isLoginBasedProvider(provider: { authMethods?: readonly string[]; id?: string }): boolean {
  const methods = provider.authMethods
  return methods !== undefined && methods.length > 0 && !methods.includes('api-key')
}
