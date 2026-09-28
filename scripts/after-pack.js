const fs = require('fs')
const path = require('path')

/**
 * 交付后置断言（v0.4.4）：LocalPaddle（文档处理通道 local-paddle）的原生闭包
 * 必须真实落盘在 app.asar.unpacked——.node 绑定与同目录 DLL 成组。v0.4.3 及之前
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

exports.default = async function (context) {
  const platform = context.packager.platform.name
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })

    const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
    // sharp 平台二进制（lib/ 内 .node + 同目录 libvips DLL——sharp 加载失败 =
    // ocrWorker 光栅化后第一步崩溃，v0.4.3 安装版实锤死因）
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
  }
}
