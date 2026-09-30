import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { describe, expect, it } from 'vitest'

import type { ReadableContentWorkerInput, ReadableContentWorkerMessage } from '../readableContentWorker'

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'readableContentWorker.ts')

/**
 * 真实 worker 语义验证：直接以 worker_threads 加载 worker 源文件（Node 24 原生
 * TS 类型剥离），不经 vitest 转换管线——信封、jsdom+Readability 管线、消息形状
 * 全部按生产路径跑通。
 */
function runWorker(input: ReadableContentWorkerInput): Promise<ReadableContentWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: input })
    const timeout = setTimeout(() => {
      void worker.terminate()
      reject(new Error('worker test timed out'))
    }, 15_000)
    worker.once('message', (message: ReadableContentWorkerMessage) => {
      clearTimeout(timeout)
      void worker.terminate()
      resolve(message)
    })
    worker.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

describe('readableContentWorker（V2 Readability worker 移植）', () => {
  it('extracts title and markdown body from an HTML page', async () => {
    const html = `<!DOCTYPE html>
      <html><head><title>测试页面</title></head><body>
        <nav>导航 导航 导航</nav>
        <article><h1>正文标题</h1><p>这是第一段正文内容。</p><p>这是第二段正文内容。</p></article>
        <footer>页脚 页脚</footer>
      </body></html>`
    const message = await runWorker({ format: 'markdown', inputKind: 'html', source: html })
    expect(message.type).toBe('result')
    if (message.type !== 'result') return
    expect(message.title).toBe('测试页面')
    expect(message.content).toContain('正文标题')
    expect(message.content).toContain('第一段正文')
  })

  it('reports an error message on unusable input instead of crashing the worker', async () => {
    const message = await runWorker({ format: 'markdown', inputKind: 'html', source: 'not-html-at-all' })
    expect(message.type).toBe('result')
    if (message.type !== 'result') return
    expect(message.content.length).toBeGreaterThan(0)
  })
})
