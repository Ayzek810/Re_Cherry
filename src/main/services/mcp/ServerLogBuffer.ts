/**
 * v0.3.2 批次3 自 CS_V1 移植 + 裁剪清单。
 *
 * CS_V1 的 MCPService 通过 ServerLogBuffer（src/main/services/mcp/ServerLogBuffer.ts）
 * 按服务器键缓存最近 200 条日志；fork 按其使用面（append/get/remove + 200 容量）重写实现。
 *
 * 裁剪：无渲染层 IPC 转发——fork 由 MCPService.onServerLog 主进程回调注册表承担分发。
 */
import type { MCPServerLogEntry } from '@shared/config/types'

/** 带服务器归属的日志条目（onServerLog 回调与 getServerLogs 的元素形态）。 */
export type MCPServerLogEntryWithServer = MCPServerLogEntry & { serverId?: string }

export class ServerLogBuffer {
  private readonly capacity: number
  private buffers: Map<string, MCPServerLogEntryWithServer[]> = new Map()

  constructor(capacity = 200) {
    this.capacity = capacity
  }

  /** 追加一条日志；超过容量时丢弃最旧的（环形语义）。 */
  append(key: string, entry: MCPServerLogEntryWithServer): void {
    let buffer = this.buffers.get(key)
    if (!buffer) {
      buffer = []
      this.buffers.set(key, buffer)
    }
    buffer.push(entry)
    if (buffer.length > this.capacity) {
      buffer.splice(0, buffer.length - this.capacity)
    }
  }

  /** 读取单个服务器的日志快照（时间序副本）。 */
  get(key: string): MCPServerLogEntryWithServer[] {
    return [...(this.buffers.get(key) ?? [])]
  }

  /** 读取全部服务器的日志快照（按服务器注册顺序拼接）。 */
  getAll(): MCPServerLogEntryWithServer[] {
    const all: MCPServerLogEntryWithServer[] = []
    for (const buffer of this.buffers.values()) {
      all.push(...buffer)
    }
    return all
  }

  /** 清除单个服务器的日志缓冲。 */
  remove(key: string): void {
    this.buffers.delete(key)
  }
}
