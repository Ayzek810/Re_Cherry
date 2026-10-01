const fs = require('fs')
const path = require('path')

/**
 * 交付后置断言：LocalPaddle（文档处理通道 local-paddle）的原生闭包
 * 必须真实落盘在 app.asar.unpacked——.node 绑定与同目录 DLL 成组。及之前
 * @img/sharp-win32-x64 被 pnpm 收集器静默丢弃（electron-builder 对顶层可解析包的
 * optionalDependencies 存在性校验看不见 .pnpm 虚拟存储，向下搜索跳过点目录），
 * 安装版 OCR 全灭且无任何构建期报错——此类缺口必须在这里变红，而不是真机。
 * 依赖声明面修复 = package.json optionalDependencies（@libsql/* 同款既有模式）
 * + electron-builder.yml asarUnpack 显式条目。
 */
function assertExists(filePath, what) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`after-pack: missing ${what}: ${filePath}`)
  }
}

/**
 * 交付断言：**每个运行时 `dependencies` 都必须有一份 package.json 落在 app.asar 内**。
 *
 * 起因（v1.0.0 真机实锤，报错栈 `out/main/index.js:36:22 Cannot find module 'electron-store'`）：
 * 仓库从 `E:\Workspace\project_REC\Re_Cherry` 迁到当前路径后，`node_modules` 顶层的 143 个 pnpm
 * junction 全部悬空（junction 存绝对路径，搬家后不跟）。在这种状态下打的 1.0.0，electron-builder
 * 的 pnpm 收集器**只丢掉了 `electron-store` 一个包**——88 个运行时依赖里 87 个在场，唯独它缺席。
 * 它在 0.5.3 才从 devDependencies 移入 dependencies（见 electron.vite.config.ts 顶部注释的同源事故），
 * 收集器沿 `.pnpm` 回溯它的落点时正好踩中悬空链接。
 *
 * 该缺口此前完全静默：构建绿、打包绿、`after-pack` 也绿（它只断言原生闭包与 OCR 入口），
 * 直到用户双击安装版才炸。所以这里改为**按 package.json 的 dependencies 逐条对账**——
 * 任何一个缺席立刻变红，而不是留到真机。
 */
function assertRuntimeDependencyClosure(asarPath) {
  const manifestPath = path.join(__dirname, '..', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const runtimeDeps = Object.keys(manifest.dependencies || {})

  const asar = require('@electron/asar')
  const entries = asar.listPackage(asarPath).map((p) =>
    String(p)
      .replace(/[\\/]+/g, '/')
      .replace(/^\/+/, '')
      .toLowerCase()
  )
  // 精确匹配 "node_modules/<name>/package.json"，同时容纳嵌套 node_modules。
  const carries = (name) => {
    const target = `node_modules/${name.toLowerCase()}/package.json`
    return entries.some((entry) => entry === target || entry.endsWith(`/${target}`))
  }

  const missing = runtimeDeps.filter((name) => !carries(name))
  if (missing.length > 0) {
    throw new Error(
      'after-pack: runtime dependencies missing from app.asar (the main bundle requires them by name at ' +
        `runtime, so the installed build dies with MODULE_NOT_FOUND): ${missing.join(', ')}. ` +
        'Usually node_modules is stale after the repository moved: run `pnpm install --frozen-lockfile` ' +
        'and package again.'
    )
  }
}

exports.default = async function (context) {
  const platform = context.packager.platform.name
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })

    const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
    // sharp 平台二进制（lib/ 内 .node + 同目录 libvips DLL——sharp 加载失败 =
    // ocrWorker 光栅化后第一步崩溃，安装版实锤死因）
    const sharpPkg = path.join(unpacked, 'node_modules', '@img', 'sharp-win32-x64')
    assertExists(path.join(sharpPkg, 'lib', 'sharp-win32-x64-0.35.3.node'), 'sharp native binding (unpacked)')
    assertExists(path.join(sharpPkg, 'lib', 'libvips-42.dll'), 'sharp libvips DLL (unpacked)')
    // onnxruntime-node（LocalPaddle 推理会话）
    const ortBin = path.join(unpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')
    assertExists(path.join(ortBin, 'onnxruntime_binding.node'), 'onnxruntime native binding (unpacked)')
    assertExists(path.join(ortBin, 'onnxruntime.dll'), 'onnxruntime DLL (unpacked)')
    // ppu-ocv（ppu-paddle-ocr 的 OpenCV 引擎依赖，含平台资产）
    assertExists(path.join(unpacked, 'node_modules', 'ppu-ocv'), 'ppu-ocv package (unpacked)')

    // ppu-paddle-ocr 本体（纯 JS，asar 内直读）+ OCR worker 入口产物在包内
    const asar = require('@electron/asar')
    const asarPath = path.join(context.appOutDir, 'resources', 'app.asar')
    const entries = asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/'))
    if (!entries.some((p) => p.endsWith('/node_modules/ppu-paddle-ocr/package.json'))) {
      throw new Error('after-pack: ppu-paddle-ocr missing from app.asar')
    }
    if (!entries.some((p) => p.endsWith('/out/main/localOcrWorker.js'))) {
      throw new Error('after-pack: out/main/localOcrWorker.js missing from app.asar (electron.vite ocrWorker entry)')
    }
    // @napi-rs/canvas：pdf.js 装 DOM 全局（DOMMatrix/Path2D/ImageData）的载体。缺它则
    // "读 PDF 文本层"与两条 OCR 光栅化腿一起死，且旧形态是 pdfjs 打一句 warn 后留个裸引用
    // （真机表现为 `DOMMatrix is not defined`）。它的平台包是 optionalDependencies，
    // 与 @img/sharp 同一坑面——必须在打包期变红。
    const canvasRoot = path.join(unpacked, 'node_modules', '@napi-rs')
    assertExists(path.join(canvasRoot, 'canvas'), '@napi-rs/canvas package (unpacked)')
    assertExists(path.join(canvasRoot, 'canvas-win32-x64-msvc'), '@napi-rs/canvas win32-x64 platform (unpacked)')

    assertRuntimeDependencyClosure(asarPath)
  } else if (platform === 'darwin' || platform === 'linux') {
    // darwin/linux：同缺口同修（跨平台交付开启前必须各自真机验证，此处只保证收集不缺包）。
    const arch = context.arch === 'arm64' || process.arch === 'arm64' ? 'arm64' : 'x64'
    const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
    const sharpName = platform === 'darwin' ? `@img/sharp-darwin-${arch}` : `@img/sharp-linux-${arch}`
    assertExists(path.join(unpacked, 'node_modules', sharpName), `sharp platform package ${sharpName} (unpacked)`)
    const ortPlatform = platform === 'darwin' ? 'darwin' : 'linux'
    assertExists(
      path.join(unpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', ortPlatform, arch),
      `onnxruntime ${ortPlatform}-${arch} native dir (unpacked)`
    )
    // @napi-rs/canvas 平台包（读 PDF / OCR 光栅化共用的 DOM 全局载体；与 win 分支同判据）
    const canvasPlatform = platform === 'darwin' ? `canvas-darwin-${arch}` : `canvas-linux-${arch}-gnu`
    assertExists(
      path.join(unpacked, 'node_modules', '@napi-rs', canvasPlatform),
      `@napi-rs/canvas platform package ${canvasPlatform} (unpacked)`
    )

    assertRuntimeDependencyClosure(path.join(context.appOutDir, 'resources', 'app.asar'))
  }
}
