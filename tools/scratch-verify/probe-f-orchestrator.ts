/**
 * Probe F（2026-09-28）：编排层 fork 路径回归实证——v0.4.4 首版把编排层打进了
 * rollup 共享 chunk（动态导入服务图），fork 用 __dirname 推导 → chunks/ 下解析
 * 不到 worker（真机 "worker exited unexpectedly (code 1)"）。修复后路径锚定
 * app 根（app.getAppPath() + out/main/localOcrWorker.js）。
 *
 * 本探针用 esbuild 把**真实源码**的 localPaddle 门面打成独立主进程，从仓库根
 * 运行（dev 应用 getAppPath = 仓库根，同款语义），走 parsePdf 真实 fork。
 * 复现：
 *   node_modules/.bin/esbuild tools/scratch-verify/probe-f-orchestrator.ts
 *     --bundle --platform=node --format=cjs
 *     --alias:@logger=./src/main/services/LoggerService --alias:@shared=./packages/shared --alias:@main=./src/main
 *     --external:electron --external:ppu-paddle-ocr --external:sharp --external:pdf-parse
 *     --external:onnxruntime-node --external:onnxruntime-common
 *     --external:winston --external:winston-daily-rotate-file --external:electron-store
 *     --outfile=probe-f-orchestrator.bundle.cjs
 *   node_modules/electron/dist/electron.exe probe-f-orchestrator.bundle.cjs
 * 判据：2 页合成 PDF 识别精确命中（模型经 probe-userdata junction 复用 scratch 模型）。
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { parsePdf } from '../../src/main/services/preprocess/localPaddle'

// 探针从仓库根运行（dev 应用 getAppPath = 仓库根，同款语义），cwd 即仓库根。
const scratchDir = path.join(process.cwd(), 'tools', 'scratch-verify')

// 模型就绪检查锚定 {userData}/Runtime/models/pp-ocrv6——探针把 userData 指向
// scratch 下的假目录，并用 junction 复用已下载的真模型（免 140MB 重复下载）。
const fakeUserData = path.join(scratchDir, 'probe-userdata')
mkdirSync(path.join(fakeUserData, 'Runtime', 'models'), { recursive: true })
const fakeModelDir = path.join(fakeUserData, 'Runtime', 'models', 'pp-ocrv6')
if (!existsSync(fakeModelDir)) {
  symlinkSync(path.join(scratchDir, 'models', 'pp-ocrv6'), fakeModelDir, 'junction')
}
app.setPath('userData', fakeUserData)

function buildPdf(texts) {
  const objs = []
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

app.whenReady().then(async () => {
  try {
    const pdfPath = path.join(scratchDir, 'probe-f-two-pages.pdf')
    writeFileSync(pdfPath, buildPdf(['PADDLE-PROBE-F-A1 ORCHESTRATOR', 'PADDLE-PROBE-F-B2 APPROOT']))
    console.log(`appPath: ${app.getAppPath()}`)
    const text = await parsePdf(pdfPath)
    console.log(`ORCH TEXT: "${text}"`)
    const ok = /PADDLE-PROBE-F-A1/.test(text) && /PADDLE-PROBE-F-B2/.test(text)
    console.log(`PROBE RESULT: ${ok ? 'PASS orchestrator real fork recognized both pages' : 'FAIL tokens missing'}`)
    app.exit(ok ? 0 : 1)
  } catch (error) {
    console.log(`PROBE RESULT: FAIL ${String((error as Error)?.message ?? error)}`)
    app.exit(1)
  }
})
