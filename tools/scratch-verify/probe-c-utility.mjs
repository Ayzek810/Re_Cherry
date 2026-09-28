/**
 * Probe C（2026-09-27，v0.4.4 LocalPaddle 修复前置实证）：
 * 真实 electron 宿主 utilityProcess 探针（§7.17 probe-ocr-utility 重建）——
 * electron.exe 运行本脚本 → utilityProcess.fork 加载真实产物 out/main/ocrWorker.js
 * → 下发 2 页合成 PDF 任务 → 收 page/done 消息。
 * 判据：两页文本均被识别（含页 1 "PADDLE-PROBE-A1"、页 2 "PADDLE-PROBE-B2"）。
 */
import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess, app } from 'electron'

const scratchDir = path.dirname(fileURLToPath(import.meta.url))
const modelDir = path.join(scratchDir, 'models', 'pp-ocrv6')
const workerJs = path.resolve(scratchDir, '..', '..', 'out', 'main', 'localOcrWorker.js')

// ---- 2 页合成 PDF ----
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
  const pdfPath = path.join(scratchDir, 'probe-c-two-pages.pdf')
  writeFileSync(pdfPath, buildPdf(['PADDLE-PROBE-A1 ELECTRON', 'PADDLE-PROBE-B2 UTILITY']))
  mkdirSync(modelDir, { recursive: true })

  const child = utilityProcess.fork(workerJs, [], { serviceName: 'probeOcrWorker', stdio: 'pipe' })
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
        /PADDLE-PROBE-A1/.test(pages.get(1) ?? '') && /PADDLE-PROBE-B2/.test(pages.get(2) ?? '')
      finish(ok ? 0 : 1, ok ? 'PASS both pages recognized' : `FAIL pages=${JSON.stringify([...pages])}`)
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
