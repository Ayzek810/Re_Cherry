/**
 * Probe E（2026-09-27）：安装形态终验——dev electron.exe 的 utilityProcess 直接
 * fork 安装包 app.asar 内的 out/main/localOcrWorker.js（Worker 的
 * import('sharp')/'ppu-paddle-ocr'/'onnxruntime-node' 将按 asar 内 node_modules
 * 解析，原生件走 app.asar.unpacked）。2 页合成 PDF，判据：两页文本精确识别。
 */
import { mkdirSync,writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app,utilityProcess } from 'electron'

const scratchDir = path.dirname(fileURLToPath(import.meta.url))
const modelDir = path.join(scratchDir, 'models', 'pp-ocrv6')
// 用法：electron.exe probe-e-packaged-worker.mjs <安装版 app.asar 绝对路径>
const asar = path.resolve(process.argv[2] ?? '')
const workerJs = path.join(asar, 'out', 'main', 'localOcrWorker.js')

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

app.whenReady().then(() => {
  console.log(`worker: ${workerJs}`)
  const pdfPath = path.join(scratchDir, 'probe-e-two-pages.pdf')
  writeFileSync(pdfPath, buildPdf(['PACKAGED-WORKER-A1', 'PACKAGED-WORKER-B2']))
  mkdirSync(modelDir, { recursive: true })

  const child = utilityProcess.fork(workerJs, [], { serviceName: 'probeEWorker', stdio: 'pipe' })
  child.stdout?.on('data', (c) => console.log(`[worker stdout] ${String(c).trim()}`))
  child.stderr?.on('data', (c) => console.log(`[worker stderr] ${String(c).trim()}`))

  const pages = new Map()
  const finish = (code, why) => {
    console.log(`PROBE RESULT: ${why}`)
    child.kill()
    setTimeout(() => app.exit(code), 200)
  }
  const guard = setTimeout(() => finish(1, 'FAIL timeout 120s'), 120_000)

  child.on('message', (raw) => {
    const m = raw
    if (m.type === 'log') console.log(`[worker log] ${m.message}`)
    else if (m.type === 'page') {
      pages.set(m.page, m.text)
      console.log(`[page ${m.page}/${m.totalPages}] "${m.text}"`)
    } else if (m.type === 'done') {
      clearTimeout(guard)
      const ok =
        /PACKAGED-WORKER-A1/.test(pages.get(1) ?? '') && /PACKAGED-WORKER-B2/.test(pages.get(2) ?? '')
      finish(ok ? 0 : 1, ok ? 'PASS packaged-worker both pages recognized' : `FAIL pages=${JSON.stringify([...pages])}`)
    } else if (m.type === 'error') {
      clearTimeout(guard)
      finish(1, `FAIL worker error: ${m.message}`)
    }
  })
  child.on('exit', (code) => {
    if (pages.size === 0) {
      clearTimeout(guard)
      finish(1, `FAIL worker exited before any page (code ${code})`)
    }
  })

  child.postMessage({
    pdfPath,
    scale: 3,
    modelPaths: {
      detection: path.join(modelDir, 'PP-OCRv6_medium_det.onnx'),
      recognition: path.join(modelDir, 'PP-OCRv6_medium_rec.onnx'),
      charactersDictionary: path.join(modelDir, 'ppocrv6_dict.txt')
    }
  })
})
