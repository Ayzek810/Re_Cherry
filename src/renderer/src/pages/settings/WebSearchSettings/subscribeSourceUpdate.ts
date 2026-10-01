/**
 * 「更新选中订阅源」的纯逻辑层。
 *
 * 修改前的行为：把订阅源列表**整片替换**为本次解析成功的条目 —— 未选中的订阅源连同
 * 它们已解析的 blacklist 一起消失，而按钮文案是「更新选中的订阅源」，并且照旧弹成功 toast。
 * 这里把合并与结果判定抽成纯函数，便于行为测试，也避免 UI 层再写一遍这套语义。
 *
 * 两类结果必须分开：
 *   · 失败：只有「有订阅源被选中」才算失败。没有选中项是无效输入，不是「更新失败」。
 *   · 成功：按 key 合并，未选中的条目与其 blacklist 原样保留。
 */

export interface SubscribeSourceItem {
  key: number
  url: string
  name: string
  blacklist?: string[]
}

export interface SubscribeDataRow {
  key: React.Key
  url: string
  name: string
}

export interface SubscribeParseSuccess {
  key: number
  url: string
  name: string
  blacklist: string[]
}

export interface SubscribeParseFailure {
  key: number
  url: string
  name: string
  error: unknown
}

export interface SubscribeParseOutcome {
  updated: SubscribeParseSuccess[]
  failed: SubscribeParseFailure[]
}

export interface MergeSubscribeSourcesResult {
  sources: SubscribeSourceItem[]
  /** 本次真正写入黑名单的条数（用成功 toast 的数字，不是选中条数）。 */
  updatedCount: number
}

/** 按 key 合并：只覆盖本次成功解析的黑名单，其余条目（含未选中）原样保留。 */
export function mergeSubscribeSources(
  existing: SubscribeSourceItem[],
  updated: SubscribeParseSuccess[]
): MergeSubscribeSourcesResult {
  const fresh = new Map(updated.map((item) => [item.key, item.blacklist]))
  const sources = existing.map((source) =>
    fresh.has(source.key) ? { ...source, blacklist: fresh.get(source.key) } : source
  )
  const seen = new Set(existing.map((source) => source.key))
  for (const item of updated) {
    if (!seen.has(item.key)) {
      sources.push({ key: item.key, url: item.url, name: item.name, blacklist: item.blacklist })
    }
  }
  return { sources, updatedCount: updated.length }
}

/**
 * 逐条解析选中订阅源。单条失败只记为失败，不影响其它条目，也不写入列表。
 * `parse` 由调用方注入（真实实现走网络，测试里注入桩），避免把网络带进纯逻辑。
 */
export async function parseSelectedSubscribeSources(
  selected: SubscribeDataRow[],
  parse: (url: string) => Promise<string[]>
): Promise<SubscribeParseOutcome> {
  const updated: SubscribeParseSuccess[] = []
  const failed: SubscribeParseFailure[] = []

  for (const source of selected) {
    try {
      const blacklist = await parse(source.url)
      if (blacklist.length === 0) {
        failed.push({
          key: Number(source.key),
          url: source.url,
          name: source.name,
          error: new Error('empty blacklist')
        })
        continue
      }
      updated.push({ key: Number(source.key), url: source.url, name: source.name, blacklist })
    } catch (error) {
      failed.push({ key: Number(source.key), url: source.url, name: source.name, error })
    }
  }

  return { updated, failed }
}
