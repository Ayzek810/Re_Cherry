/* OCR worker 真宿主探针（§4.26 三要素：加载产物、接管全部可观测面、独立看门狗）。
 * 运行：node_modules/electron/dist/electron.exe tools/probe-ocr-worker.js */
const { app, utilityProcess } = require('electron')
const path = require('path')
const fs = require('fs')

app.whenReady().then(() => {
  const workerPath = path.join(__dirname, '..', 'out', 'main', 'ocrWorker.js')
  const modelDir = path.join(
    process.env.USERPROFILE,
    'AppData',
    'Roaming',
    'Re_CherryDev',
    'Runtime',
    'models',
    'pp-ocrv6'
  )
  const pdfPath = process.argv[2] || path.join(__dirname, 'probe-ocr-sample.pdf')

  console.log('[probe] worker:', fs.existsSync(workerPath))
  console.log(
    '[probe] models exist:',
    ['PP-OCRv6_medium_det.onnx', 'PP-OCRv6_medium_rec.onnx', 'ppocrv6_dict.txt'].map((f) =>
      fs.existsSync(path.join(modelDir, f))
    )
  )
  console.log('[probe] pdf exists:', fs.existsSync(pdfPath))

  const child = utilityProcess.fork(workerPath, [], { serviceName: 'probeOcrWorker', stdio: 'pipe' })
  child.stdout?.on('data', (d) => console.log('[worker.stdout]', String(d).trim()))
  child.stderr?.on('data', (d) => console.log('[worker.stderr]', String(d).trim()))
  child.on('message', (m) => {
    const text =
      m && m.type === 'page' ? `{type:'page', page:${m.page}, textLen:${(m.text || '').length}}` : JSON.stringify(m)
    console.log('[worker.message]', text)
    if (m && (m.type === 'done' || m.type === 'error')) {
      console.log('[probe] DONE')
      app.exit(0)
    }
  })
  child.on('exit', (code) => {
    console.log('[worker.exit] code =', code)
    app.exit(code ?? 1)
  })
  child.postMessage({
    pdfPath,
    scale: 2,
    modelPaths: {
      detection: path.join(modelDir, 'PP-OCRv6_medium_det.onnx'),
      recognition: path.join(modelDir, 'PP-OCRv6_medium_rec.onnx'),
      charactersDictionary: path.join(modelDir, 'ppocrv6_dict.txt')
    }
  })
  setTimeout(() => {
    console.log('[probe] TIMEOUT 90s')
    child.kill()
    app.exit(2)
  }, 90000)
})
