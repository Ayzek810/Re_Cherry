/**
 * 诊断（v0.4.4-1 GPU 加速研究）：PP-OCRv6 det/rec 真模型在 CPU vs DirectML 上的
 * 会话创建与推理耗时（onnxruntime-node 1.25.1，win32/x64，模型取 scratch 已下载件）。
 * 判据：DML 会话能否创建、首推（含编译）与稳态推理 vs CPU 的比值。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ort from 'onnxruntime-node'

const scratchDir = path.dirname(fileURLToPath(import.meta.url))
const modelDir = path.join(scratchDir, 'models', 'pp-ocrv6')

const detBuf = await readFile(path.join(modelDir, 'PP-OCRv6_medium_det.onnx'))
const recBuf = await readFile(path.join(modelDir, 'PP-OCRv6_medium_rec.onnx'))

function randTensor(dims) {
  const size = dims.reduce((a, b) => a * b, 1)
  const data = new Float32Array(size)
  for (let i = 0; i < size; i++) data[i] = Math.random()
  return new ort.Tensor('float32', data, dims)
}

async function bench(label, createProviders, modelBuf, dims, runs) {
  const t0 = Date.now()
  let session
  try {
    session = await ort.InferenceSession.create(modelBuf, { executionProviders: createProviders })
  } catch (error) {
    console.log(`${label}: CREATE FAILED — ${String(error?.message ?? error).slice(0, 140)}`)
    return
  }
  const createMs = Date.now() - t0
  const input = randTensor(dims)
  const feed = { [session.inputNames[0]]: input }
  // 预热一次（DML 首推含编译）
  await session.run(feed)
  const t1 = Date.now()
  for (let i = 0; i < runs; i++) await session.run(feed)
  const avg = (Date.now() - t1) / runs
  console.log(`${label}: create=${createMs}ms warmup=${t1 - t0 - createMs}ms avg-run=${avg.toFixed(1)}ms ×${runs}`)
  await session.release()
}

const eps = process.argv[2] ?? 'dml'
console.log(`=== det (1x3x640x832) ===`)
await bench(`cpu det`, ['cpu'], detBuf, [1, 3, 640, 832], 5)
await bench(`${eps} det`, [eps], detBuf, [1, 3, 640, 832], 5)
console.log(`=== rec (1x3x48x320) ===`)
await bench(`cpu rec`, ['cpu'], recBuf, [1, 3, 48, 320], 10)
await bench(`${eps} rec`, [eps], recBuf, [1, 3, 48, 320], 10)
process.exit(0)
