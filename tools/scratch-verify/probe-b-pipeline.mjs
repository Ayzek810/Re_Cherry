/**
 * Probe B（2026-09-27，v0.4.4 LocalPaddle 修复前置实证）：
 * plain-node 全管线复刻 ocrWorker.ts——模型下载（三文件，缺则补）→ 合成 PDF
 * → pdf-parse getScreenshot 3x 光栅化 → sharp 预处理 → ppu-paddle-ocr 推理
 * → 断言识别文本。
 * 判据：识别结果含 "LocalPaddle" 与数字串（合成 PDF 内容），容许少量噪声。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratchDir = path.dirname(fileURLToPath(import.meta.url))
const modelDir = path.join(scratchDir, 'models', 'pp-ocrv6')
await mkdir(modelDir, { recursive: true })

const FILES = [
  {
    label: 'det',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/master/inference.onnx',
    dest: path.join(modelDir, 'PP-OCRv6_medium_det.onnx'),
    minBytes: 1_000_000
  },
  {
    label: 'rec',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/master/inference.onnx',
    dest: path.join(modelDir, 'PP-OCRv6_medium_rec.onnx'),
    minBytes: 1_000_000
  },
  {
    label: 'dict',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/master/inference.yml',
    dest: path.join(modelDir, 'inference.yml'),
    minBytes: 10_000
  }
]

for (const f of FILES) {
  if (existsSync(f.dest) && (await readFile(f.dest)).length >= f.minBytes) {
    console.log(`skip ${f.label} (already present)`)
    continue
  }
  console.log(`downloading ${f.label} ...`)
  const res = await fetch(f.url)
  if (!res.ok) throw new Error(`${f.label}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < f.minBytes) throw new Error(`${f.label}: too small (${buf.length})`)
  await writeFile(f.dest, buf)
  console.log(`done ${f.label}: ${buf.length} bytes`)
}

// ---- 字典：复刻 localModelService.dictTextFromInferenceYml ----
const { parse: yamlParse } = await import('yaml')
const yml = await readFile(FILES[2].dest, 'utf8')
const config = yamlParse(yml)
const characters = config?.PostProcess?.character_dict
if (!Array.isArray(characters) || characters.length === 0) throw new Error('inference.yml missing PostProcess.character_dict')
const dictPath = path.join(modelDir, 'ppocrv6_dict.txt')
writeFileSync(dictPath, `\n${characters.map(String).join('\n')}\n`)
console.log(`dict entries: ${characters.length}`)

// ---- 合成 PDF（最小结构 + Helvetica 标准字体文本） ----
function buildPdf(text) {
  const esc = text.replace(/([\\()])/g, '\\$1')
  const content = `BT /F1 28 Tf 72 720 Td (${esc}) Tj ET`
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
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

const pdfBytes = buildPdf('Hello LocalPaddle 20260927 OK')

// ---- 光栅化 + 预处理 + 推理（与 ocrWorker.ts 同参） ----
const { CanvasFactory } = await import('pdf-parse/worker')
const { PDFParse } = await import('pdf-parse')
const parser = new PDFParse({ data: new Uint8Array(pdfBytes), CanvasFactory })
let rasterBytes = 0
let pngPath = ''
try {
  const screenshot = await parser.getScreenshot({ partial: [1], scale: 3, imageBuffer: true, imageDataUrl: false })
  const rendered = screenshot.pages[0]?.data
  if (!rendered) throw new Error('rasterization produced no page data')
  rasterBytes = rendered.length ?? rendered.byteLength ?? 0
  const sharp = (await import('sharp')).default
  const pre = await sharp(Buffer.from(rendered)).grayscale().normalize().sharpen().png({ quality: 100 }).toBuffer()
  pngPath = path.join(scratchDir, 'probe-b-page.png')
  writeFileSync(pngPath, pre)

  const { PaddleOcrService } = await import('ppu-paddle-ocr')
  const t0 = Date.now()
  const service = new PaddleOcrService({
    model: {
      detection: path.join(modelDir, 'PP-OCRv6_medium_det.onnx'),
      recognition: path.join(modelDir, 'PP-OCRv6_medium_rec.onnx'),
      charactersDictionary: dictPath
    },
    session: {}
  })
  await service.initialize()
  console.log(`service initialized in ${Date.now() - t0}ms`)
  const buffer = await readFile(pngPath)
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const result = await service.recognize(bytes)
  console.log(`raster bytes=${rasterBytes} png=${pre.length}`)
  console.log(`RECOGNIZED TEXT: "${result.text}"`)
  const ok = /LocalPaddle/.test(result.text) && /20260927/.test(result.text)
  console.log(ok ? 'PASS: pipeline end-to-end recognized the synthetic page' : 'FAIL: expected tokens missing')
  process.exit(ok ? 0 : 1)
} finally {
  await parser.destroy().catch(() => undefined)
}
