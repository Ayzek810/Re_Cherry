/** 诊断：pdf-parse v2 的 getInfo().total 与 getText().total 对 2 页合成 PDF 的取值。 */

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

const pdf = buildPdf(['PAGE ONE', 'PAGE TWO'])
const { CanvasFactory } = await import('pdf-parse/worker')
const { PDFParse } = await import('pdf-parse')
const parser = new PDFParse({ data: new Uint8Array(pdf), CanvasFactory })
try {
  const info = await parser.getInfo()
  console.log(`getInfo().total = ${info.total}`)
  const text = await parser.getText()
  console.log(`getText().total = ${text.total}`)
  const info2 = await parser.getInfo()
  console.log(`getInfo().total (after getText) = ${info2.total}`)
} finally {
  await parser.destroy().catch(() => undefined)
}
