/**
 * Probe A（2026-09-27，v0.4.4 LocalPaddle 修复前置实证）：
 * ModelScope 三直链 Range 探测——det/rec 权重 + inference.yml。
 * 判定：HTTP 200/206 + Content-Range 总长（权重 >1MB、yml >10KB 即 minBytes 门槛）。
 */
const targets = [
  {
    label: 'det',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/master/inference.onnx',
    minBytes: 1_000_000
  },
  {
    label: 'rec',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/master/inference.onnx',
    minBytes: 1_000_000
  },
  {
    label: 'yml',
    url: 'https://www.modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/master/inference.yml',
    minBytes: 10_000
  }
]

let failed = false
for (const t of targets) {
  try {
    const res = await fetch(t.url, { method: 'GET', headers: { Range: 'bytes=0-1023' } })
    const cr = res.headers.get('content-range') ?? ''
    const total = Number(cr.split('/')[1] ?? 0)
    const ok = (res.status === 206 || res.status === 200) && total >= t.minBytes
    console.log(`${ok ? 'PASS' : 'FAIL'} ${t.label} status=${res.status} total=${total} minBytes=${t.minBytes} content-range="${cr}"`)
    if (!ok) failed = true
    // 消费 body 防 socket 悬挂
    await res.arrayBuffer()
  } catch (error) {
    failed = true
    console.log(`FAIL ${t.label} error=${String(error)}`)
  }
}
process.exit(failed ? 1 : 0)
