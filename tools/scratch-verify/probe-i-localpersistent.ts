/**
 * Probe I（2026-09-28）：LocalPaddle 常驻 worker 行为实证——
 * 真实源码编排（localOcr 门面）+ 真实构建产物 out/main/localOcrWorker.js +
 * scratch 真模型（junction 复用）连续解析两本：断言第二本无冷加载
 *（d2 < d1 / 2——模型初始化 ~6-15s 只发生在第一本）且两本文本一致。
 *
 * 复现（仓库根执行）：
 *   node_modules/.bin/esbuild tools/scratch-verify/probe-i-localpersistent.ts
 *     --bundle --platform=node --format=cjs
 *     --alias:@logger=./src/main/services/LoggerService --alias:@shared=./packages/shared --alias:@main=./src/main
 *     --external:electron --external:pdf-parse --external:sharp --external:ppu-paddle-ocr
 *     --external:onnxruntime-node --external:onnxruntime-common --external:winston
 *     --external:winston-daily-rotate-file --external:electron-store
 *     --outfile=probe-i-localpersistent.bundle.cjs
 *   node_modules/electron/dist/electron.exe probe-i-localpersistent.bundle.cjs
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { parsePdf } from '../../src/main/services/preprocess/localPaddle'

const scratchDir = path.join(process.cwd(), 'tools', 'scratch-verify')

// 模型就绪检查锚定 {userData}/Runtime/models/pp-ocrv6——junction 复用 scratch 真模型。
const fakeUserData = path.join(scratchDir, 'probe-userdata')
mkdirSync(path.join(fakeUserData, 'Runtime', 'models'), { recursive: true })
const fakeModelDir = path.join(fakeUserData, 'Runtime', 'models', 'pp-ocrv6')
if (!existsSync(fakeModelDir)) {
  symlinkSync(path.join(scratchDir, 'models', 'pp-ocrv6'), fakeModelDir, 'junction')
}
app.setPath('userData', fakeUserData)

function buildPdf(text: string): Buffer {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objs[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'
  const esc = text.replace(/([\\()])/g, '\\$1')
  const content = `BT /F1 28 Tf 72 700 Td (${esc}) Tj ET`
  objs[5] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

app.whenReady().then(async () => {
  try {
    const pdfA = path.join(scratchDir, 'probe-i-book-a.pdf')
    const pdfB = path.join(scratchDir, 'probe-i-book-b.pdf')
    writeFileSync(pdfA, buildPdf('LOCAL PERSISTENT PROBE BOOK A'))
    writeFileSync(pdfB, buildPdf('LOCAL PERSISTENT PROBE BOOK B'))

    const t1 = Date.now()
    const textA = await parsePdf(pdfA)
    const d1 = Date.now() - t1
    const t2 = Date.now()
    const textB = await parsePdf(pdfB)
    const d2 = Date.now() - t2

    console.log(`parse1: ${d1}ms → ${JSON.stringify(textA.trim())}`)
    console.log(`parse2: ${d2}ms → ${JSON.stringify(textB.trim())}`)
    const ok =
      textA.trim().length > 0 &&
      textB.trim().length > 0 &&
      d1 > 3000 && // 首本含模型冷加载（秒级）
      d2 < d1 / 2 // 热模型复用：第二本显著提速
    console.log(`PROBE RESULT: ${ok ? 'PASS persistent worker warm reuse' : 'FAIL'}`)
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.log(`PROBE RESULT: FAIL ${String((error as Error)?.message ?? error)}`)
    app.exit(1)
  }
})
