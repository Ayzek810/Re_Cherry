// fork 缝（原创）：错误详情拼接单点。
// 三个地方（手动检查更新、paper-agent 启动/停止、受管工具安装）都要把主进程给出的
// 原始失败原因贴到 toast 标题后面；此前是三份逐字相同的本地实现——一处改了长度上限、
// 另一处不改就会漂移。文案键由调用方给（各场景标题不同），本件只负责"标题 + 截断详情"。

/** 详情上限：主进程消息可能带 pnpm/npm 的多行尾巴，toast 只该展示可读的一小段。 */
export const ERROR_DETAIL_LIMIT = 200

/** `标题` 或 `标题: 详情`（详情去空白后截断；空详情只返回标题）。 */
export function withDetail(title: string, detail: string | undefined): string {
  const trimmed = detail?.trim()
  return trimmed ? `${title}: ${trimmed.slice(0, ERROR_DETAIL_LIMIT)}` : title
}
