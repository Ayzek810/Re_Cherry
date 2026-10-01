import { loggerService } from '@logger'
import { isDev } from '@main/constant'
import { CacheBatchSpanProcessor, FunctionSpanExporter } from '@mcp-trace/trace-core'
import { NodeTracer as MCPNodeTracer } from '@mcp-trace/trace-node/nodeTracer'
import { BrowserWindow } from 'electron'
import * as path from 'path'

import { ConfigKeys, configManager } from './ConfigManager'
import { spanCacheService } from './SpanCacheService'

// v0.3.1-2：上报器名改为本 fork 标识（原为上游 'CherryStudio'；此项仅出现在 trace 视图中，非功能标识）。
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
}

export const nodeTraceService = new NodeTraceService()

let traceWin: BrowserWindow | null = null

export function openTraceWindow(topicId: string, traceId: string, autoOpen = true, modelName?: string) {
  if (traceWin && !traceWin.isDestroyed()) {
    traceWin.focus()
    traceWin.webContents.send('set-trace', { traceId, topicId, modelName })
    return
  }

  if (!traceWin && !autoOpen) {
    return
  }

  traceWin = new BrowserWindow({
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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void traceWin.loadURL(process.env['ELECTRON_RENDERER_URL'] + `/traceWindow.html`)
  } else {
    void traceWin.loadFile(path.join(__dirname, '../renderer/traceWindow.html'))
  }
  traceWin.on('closed', () => {
    configManager.unsubscribe(ConfigKeys.Language, setLanguageCallback)
    try {
      traceWin?.destroy()
    } finally {
      traceWin = null
    }
  })

  traceWin.webContents.on('did-finish-load', () => {
    traceWin!.webContents.send('set-trace', {
      traceId,
      topicId,
      modelName
    })
    traceWin!.webContents.send('set-language', { lang: configManager.get(ConfigKeys.Language) })
    configManager.subscribe(ConfigKeys.Language, setLanguageCallback)
  })
}

const setLanguageCallback = (lang: string) => {
  traceWin!.webContents.send('set-language', { lang })
}

export const setTraceWindowTitle = (title: string) => {
  if (traceWin) {
    traceWin.title = title
  }
}
