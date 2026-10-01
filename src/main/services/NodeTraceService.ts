import { loggerService } from '@logger'
import { isDev } from '@main/constant'
import { CacheBatchSpanProcessor, FunctionSpanExporter } from '@mcp-trace/trace-core'
import { NodeTracer as MCPNodeTracer } from '@mcp-trace/trace-node/nodeTracer'
import { IpcChannel } from '@shared/IpcChannel'
import { BrowserWindow } from 'electron'
import * as path from 'path'

import { ConfigKeys, configManager } from './ConfigManager'
import { spanCacheService } from './SpanCacheService'

// 上报器名改为本 fork 标识（原为上游 'CherryStudio'；此项仅出现在 trace 视图中，非功能标识）。
export const TRACER_NAME = 'Re_Cherry'

const logger = loggerService.withContext('NodeTraceService')

export class NodeTraceService {
  init() {
    const exporter = new FunctionSpanExporter(async (spans) => {
      logger.info(`Spans length: ${spans.length}`)
    })

    MCPNodeTracer.init(
      {
        defaultTracerName: TRACER_NAME,
        serviceName: TRACER_NAME
      },
      new CacheBatchSpanProcessor(exporter, spanCacheService)
    )
  }

  /**
   * 退出前冲刷并关闭 tracer。
   *
   * 为什么必须显式收尾：tracer 的批处理器持有在途 span，进程直接退出会把未导出的 span 丢掉；
   * 适配器已提供 `forceFlush/shutdown`，但此前没有任何调用点——等于能力悬空。
   * 失败只记日志：退出路径不得因可观测性组件抛错而卡住。
   */
  async shutdown(): Promise<void> {
    try {
      await MCPNodeTracer.forceFlush()
      await MCPNodeTracer.shutdown()
    } catch (error) {
      logger.warn('Failed to shut down the node tracer', error as Error)
    }
  }
}

export const nodeTraceService = new NodeTraceService()

let traceWin: BrowserWindow | null = null

export function openTraceWindow(topicId: string, traceId: string, autoOpen = true, modelName?: string) {
  if (traceWin && !traceWin.isDestroyed()) {
    traceWin.focus()
    traceWin.webContents.send(IpcChannel.Trace_SetTrace, { traceId, topicId, modelName })
    return
  }

  if (!traceWin && !autoOpen) {
    return
  }

  // 窗口实例同时捕获进局部常量——下面的监听器与语言回调只认这一次创建的窗口，
  // 不再经模块级可变引用回读（`traceWin` 会在 closed 时置 null）。
  const win = new BrowserWindow({
    width: 600,
    minWidth: 500,
    minHeight: 600,
    height: 800,
    autoHideMenuBar: true,
    closable: true,
    focusable: true,
    movable: true,
    hasShadow: true,
    roundedCorners: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
    title: 'Call Chain Window',
    frame: true,
    titleBarOverlay: { height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev ? true : false
    }
  })

  traceWin = win

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + `/traceWindow.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/traceWindow.html'))
  }

  // 语言回调捕获**本次**窗口实例（原来用模块级 `traceWin!`——
  // 回调可能在窗口已 closed、`traceWin` 已置 null 的窗口期被同步调用，抛
  // `TypeError: Cannot read properties of null`；`ConfigManager.notifySubscribers` 是
  // 同步 forEach，该异常会中断同批后续订阅者，把「切语言」变成部分失效）。
  // 订阅也改成「先退订再订阅」：`did-finish-load` 在 reload / HMR 后会再次触发，
  // 而 `ConfigManager.subscribe` 是数组 push，重复订阅会让同一次语言切换发 N 次。
  const onLanguageChanged = (lang: string) => {
    if (win.isDestroyed()) return
    win.webContents.send(IpcChannel.Trace_SetLanguage, { lang })
  }

  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send(IpcChannel.Trace_SetTrace, {
      traceId,
      topicId,
      modelName
    })
    win.webContents.send(IpcChannel.Trace_SetLanguage, { lang: configManager.get(ConfigKeys.Language) })
    // 退订后再订阅：重复的 `did-finish-load`（reload / HMR / 重定向）不会叠加订阅者。
    configManager.unsubscribe(ConfigKeys.Language, onLanguageChanged)
    configManager.subscribe(ConfigKeys.Language, onLanguageChanged)
  })

  win.on('closed', () => {
    configManager.unsubscribe(ConfigKeys.Language, onLanguageChanged)
    if (traceWin === win) {
      traceWin = null
    }
  })
}

export const setTraceWindowTitle = (title: string) => {
  if (traceWin) {
    traceWin.title = title
  }
}
