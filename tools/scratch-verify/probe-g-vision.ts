/**
 * Probe G（2026-09-28）：视觉模型文档处理全链行为实证——真实源码门面（vision facade
 * → visionParse 编排 → 真实构建产物 out/main/visionWorker.js 光栅化）+ 本地 stub
 * LLM（OpenAI 兼容 /chat/completions，注入 lightLlmModalities 路由快照）。
 *
 * 复现（仓库根执行）：
 *   node_modules/.bin/esbuild tools/scratch-verify/probe-g-vision.ts
 *     --bundle --platform=node --format=cjs
 *     --alias:@logger=./src/main/services/LoggerService --alias:@shared=./packages/shared --alias:@main=./src/main
 *     --external:electron --external:pdf-parse --external:winston --external:winston-daily-rotate-file
 *     --external:electron-store
 *     --outfile=probe-g-vision.bundle.cjs
 *   node_modules/electron/dist/electron.exe probe-g-vision.bundle.cjs
 *
 * 判据（stub 侧核验 + 端到端文本）：
 * 1. 两次 /chat/completions 调用：content[0] 为指令文本、content[1] 为 data:image/png
 *    data URL 且解码后是合法 PNG（魔数 + IHDR 宽度 >1000 = 真实光栅化产物）；
 * 2. 最终文本 = 'VISION-STUB-1\n\nVISION-STUB-2'（按序拼装）。
 */
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'

import { app } from 'electron'

import { setLightLlmProviderRoutes } from '../../src/main/kernel/lightLlmModalities'
import { parsePdf } from '../../src/main/services/preprocess/vision'

// CJS bundle 里 import.meta 为空（probe F 同款坑）——探针从仓库根运行，cwd 即仓库根。
const scratchDir = path.join(process.cwd(), 'tools', 'scratch-verify')
// worker 路径锚定 app 根（dev = 仓库根），与编排层同语义。
const appRoot = process.cwd()

function buildPdf(texts: string[]): Buffer {
  const objs: string[] = []
  const pageNums = texts.map((_, i) => 4 + i * 2)
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ')
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 0; i < texts.length; i++) {
    const contentNum = pageNums[i] + 1
    objs[pageNums[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`
  }
  for (let i = 0; i < texts.length; i++) {
    const esc = texts[i].replace(/([\\()])/g, '\\$1')
    const content = `BT /F1 28 Tf 72 700 Td (${esc}) Tj ET`
    objs[pageNums[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  }
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objs.length; i++) {
    if (objs[i] === undefined) continue
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) {
    out += objs[i] === undefined ? '0000000000 65535 f \n' : `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

interface StubCheck {
  promptSeen: boolean
  pngMagic: boolean
  pngWidth: number
}

function startStub(checks: StubCheck[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          model: string
          messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>
        }
        const check: StubCheck = { promptSeen: false, pngMagic: false, pngWidth: 0 }
        const content = parsed.messages[0]?.content ?? []
        for (const part of content) {
          if (part.type === 'text' && (part.text ?? '').includes('document transcription engine')) {
            check.promptSeen = true
          }
          if (part.type === 'image_url') {
            const url = part.image_url?.url ?? ''
            const match = /^data:image\/png;base64,(.+)$/s.exec(url)
            if (match !== null) {
              const png = Buffer.from(match[1], 'base64')
              // PNG 魔数 + IHDR 宽度（offset 16，big-endian 4 字节）
              check.pngMagic = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
              check.pngWidth = png.readUInt32BE(16)
            }
          }
        }
        checks.push(check)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: `VISION-STUB-${checks.length}` } }] }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

app.whenReady().then(async () => {
  try {
    console.log(`appPath: ${app.getAppPath()} (expected ${appRoot})`)
    const checks: StubCheck[] = []
    const { server, port } = await startStub(checks)
    setLightLlmProviderRoutes([{ id: 'stub', apiHost: `http://127.0.0.1:${port}`, apiKey: 'sk-stub' }])

    const pdfPath = path.join(scratchDir, 'probe-g-two-pages.pdf')
    writeFileSync(pdfPath, buildPdf(['VISION PROBE G PAGE ONE', 'VISION PROBE G PAGE TWO']))
    const text = await parsePdf(pdfPath, { provider: 'stub', model: 'stub-vision' })
    server.close()

    console.log(`ASSEMBLED TEXT: ${JSON.stringify(text)}`)
    console.log(`stub checks: ${JSON.stringify(checks)}`)
    const ok =
      text === 'VISION-STUB-1\n\nVISION-STUB-2' &&
      checks.length === 2 &&
      checks.every((c) => c.promptSeen && c.pngMagic && c.pngWidth > 1000)
    console.log(`PROBE RESULT: ${ok ? 'PASS vision document full chain' : 'FAIL'}`)
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.log(`PROBE RESULT: FAIL ${String((error as Error)?.message ?? error)}`)
    app.exit(1)
  }
})
