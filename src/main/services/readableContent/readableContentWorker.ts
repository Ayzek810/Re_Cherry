import { parentPort, workerData } from 'node:worker_threads'

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

// fork 缝：V2 同文件（readableContentWorker.ts）裁剪——preview 格式随 V2 的
// CitationPreviewService 而生，fork 无该消费面，只保留 markdown 通道。
const SAFE_JSDOM_URL = 'http://localhost/'

export type ReadableContentWorkerInput = {
  readonly format: 'markdown'
  readonly inputKind: 'html'
  readonly source: string
}

export type ReadableContentWorkerMessage =
  | { type: 'result'; title: string; content: string }
  | { type: 'error'; message: string }

// ?nodeWorker 生产路径恒有 parentPort；直导入（vitest 等）无 port——静默跳过
// 而不是在 import 期抛错（否则任何传递引用本文件的测试套件都收集失败）。
if (parentPort) {
  const input = workerData as ReadableContentWorkerInput

  try {
    let title = ''
    let content = input.source

    if (input.inputKind === 'html') {
      const dom = new JSDOM(input.source, { url: SAFE_JSDOM_URL })

      try {
        const article = new Readability(dom.window.document).parse()
        title = article?.title || ''
        content = article?.textContent || ''

        if (article && input.format === 'markdown') {
          content = new TurndownService().turndown(article.content || '').trim()
        }
      } finally {
        dom.window.close()
      }
    }

    parentPort.postMessage({ type: 'result', title, content } satisfies ReadableContentWorkerMessage)
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    } satisfies ReadableContentWorkerMessage)
  }
}
