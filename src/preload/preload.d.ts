import type { WindowApiType } from './index'

/**
 * `window.electron` 不再是 `@electron-toolkit/preload` 的整个 `ElectronAPI`：
 * 只留白名单化的 `ipcRenderer.invoke/send` 与最小 `process`（`platform` + 三个日志键）。
 * 渲染层的主通路是 `window.api`；`window.electron` 只服务少数未迁到 `api` 的调用点。
 */
export interface RendererElectronBridge {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    send: (channel: string, ...args: unknown[]) => void
  }
  process: {
    platform: string
    env: Record<string, string | undefined>
  }
}

/** you don't need to declare this in your code, it's automatically generated */
declare global {
  interface Window {
    electron: RendererElectronBridge
    api: WindowApiType
  }
}
