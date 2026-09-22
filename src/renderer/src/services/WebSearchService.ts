/**
 * 网络搜索渲染层服务（批次2）。
 *
 * 职责只有两件：就绪判定（isWebSearchEnabled——面板过滤、发送链挂载判据共用）
 * 与连通性检查（checkSearch——设置页「检查」按钮，经 IPC 走主进程引擎真实执行
 * 路径，比上游渲染层侧测更诚实）。搜索执行本体在主进程
 * src/main/services/WebSearchService（内核 web_search 工具消费），不经渲染层。
 */
import store from '@renderer/store'

/**
 * 提供商就绪判定（上游 WebSearchService.isWebSearchEnabled 同语义）：
 * 清单里不存在 → false；local- 前缀（本地引擎，无需凭据）→ true；
 * 有 apiKey 字段看非空（key 型：tavily/bocha/zhipu/exa/querit）；
 * 有 apiHost 字段看非空（host 型：searxng/exa-mcp）。
 */
export function isWebSearchEnabled(providerId: string): boolean {
  const provider = store.getState().websearch.providers.find((p) => p.id === providerId)
  if (provider === undefined) return false
  if (provider.id.startsWith('local-')) return true
  if ('apiKey' in provider) return provider.apiKey !== ''
  if ('apiHost' in provider) return provider.apiHost !== ''
  return false
}

/**
 * 连通性检查：主进程引擎用 'test query' 真跑一次该提供商，results 非空即就绪。
 * 沿真实执行路径（同 web_search 工具），失败即失败，不做任何假成功。
 */
export async function checkSearch(providerId: string): Promise<boolean> {
  const { ok } = await window.api.webSearch.check(providerId)
  return ok === true
}
