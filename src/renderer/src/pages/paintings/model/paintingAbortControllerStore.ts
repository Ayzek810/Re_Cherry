/**
 * 按画作登记的取消控制器（paintingId → AbortController）。
 *
 * fork 缝：V2 paintingAbortControllerStore 的 fork 移植。此前的取消只认 hook 里单一
 * 槽位（`abortStateRef`），`cancel(paintingId)` 从不读 paintingId——正在生成 A 时删掉
 * 旧画 B，被掐断的是 A。这里按 id 登记，取消只掐对应画作；未登记的 id 是无害空操作。
 * 渲染层簿记只覆盖本进程生命周期（刷新即失效），真正掐断付费请求的是主进程侧
 * requestId 配对的 lightImageAbort（requestId = paintingId，见 canonicalGenerate）。
 */
const abortControllers = new Map<string, AbortController>()

export function registerPaintingAbortController(paintingId: string, controller: AbortController): void {
  abortControllers.get(paintingId)?.abort()
  abortControllers.set(paintingId, controller)
}

export function getPaintingAbortController(paintingId: string): AbortController | null {
  return abortControllers.get(paintingId) ?? null
}

export function clearPaintingAbortController(paintingId: string, controller?: AbortController): void {
  if (!controller || abortControllers.get(paintingId) === controller) {
    abortControllers.delete(paintingId)
  }
}

export function abortPaintingGeneration(paintingId: string): void {
  abortControllers.get(paintingId)?.abort()
}
