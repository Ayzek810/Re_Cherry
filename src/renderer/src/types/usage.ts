/**
 * 用量统计类型：回合级 usage 记录（Dexie usage_records 表行，v18 起用）。
 * 派生分析数据——内核会话日志里的 usage 事件才是源头，本表是本地聚合用镜像。
 */
export interface UsageRecord {
  id?: number
  /** 回合结束时刻（epoch ms）。 */
  timestamp: number
  topicId: string
  assistantId: string
  modelId: string
  providerId?: string
  inputTokens: number
  outputTokens: number
}
