/**
 * 删除前后都必须绿：
 *
 * `NodeTraceService` 曾于模块求值期全局改写 `ipcMain.handle`，按"末参形状"
 * （任意末参对象带 `type === 'trace'`）静默丢弃调用方的最后一个实参。唯一的生产者
 * `preload.tracedInvoke` 零调用，因此这不是 trace 传播，而是挂在全进程 IPC 上的死码。
 *
 * 该改写删除后，本文件锁定两条事实：
 * 1. 导入 `NodeTraceService` 不再触碰 `ipcMain.handle`（全进程 IPC 未被猴补）；
 * 2. trace 栈（NodeTracer → CacheBatchSpanProcessor → SpanCacheService → trace 窗读取面）
 *    仍然完整可用——span 能被登记、按 topicId/traceId 读回。
 */
import { trace } from '@opentelemetry/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { configManager } from '../ConfigManager'
import { spanCacheService } from '../SpanCacheService'

const { ipcMain } = await import('electron')

// 静态导入：模块求值期就是曾经发生猴补的时刻。
const { TRACER_NAME, nodeTraceService } = await import('../NodeTraceService')

describe('NodeTraceService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 开发者模式是 SpanCacheService 的登记门；测试 store 是内存桩，直接打桩读取面。
    vi.spyOn(configManager, 'getEnableDeveloperMode').mockReturnValue(true)
    spanCacheService.clear()
    nodeTraceService.init()
  })

  it('does not rewrite ipcMain.handle at module evaluation time', () => {
    // 猴补版本会在 import 期替换 `ipcMain.handle`；此后任何通道注册都落到被包裹的实现上，
    // 且"末参带 type: 'trace' 的对象"会被启发式吞掉。此处断言处理器原样到达注册点。
    const handler = vi.fn()
    ipcMain.handle('trace-probe', handler)

    const registered = vi.mocked(ipcMain.handle).mock.calls.at(-1)?.[1] as (
      event: unknown,
      ...args: unknown[]
    ) => unknown
    expect(registered).toBe(handler)
  })

  it('still records spans end-to-end after the patch removal (trace stack is live)', async () => {
    const tracer = trace.getTracer(TRACER_NAME)
    const span = tracer.startSpan('trace-span')
    const spanId = span.spanContext().spanId
    const traceId = span.spanContext().traceId
    span.end()

    // 处理器是批量的：flush 一次，让 CacheBatchSpanProcessor 把 span 交给 SpanCacheService。
    const provider = trace.getTracerProvider() as unknown as { forceFlush?: () => Promise<void> }
    await provider.forceFlush?.()

    // trace 窗的读取面（ipc.ts TRACE_GET_DATA 的同一入口）：
    // 绑定 topicId 后按 (topicId, traceId) 读回刚结束的 span。
    spanCacheService.setTopicId(traceId, 'trace-topic')
    const entity = spanCacheService.getEntity(spanId)
    expect(entity).toBeDefined()
    expect(entity?.traceId).toBe(traceId)
  })
})
