/**
 * Probe D（2026-09-27）：在真实安装版产物上复现 sharp 加载死亡。
 * electron.exe（dist/win-unpacked）运行本脚本：按 ocrWorker 的加载方式
 * require(app.asar 内的 sharp)，捕获并打印错误，退出码表达结论。
 */
import { createRequire } from 'node:module'
import path from 'node:path'

// 用法：electron.exe probe-d-packaged-sharp.mjs <安装版 app.asar 绝对路径>
// electron 主进程 argv：[0]=electron [1]=本脚本 [2]=首个实参
const asar = path.resolve(process.argv[2] ?? '')
console.log(`asar path: ${asar}`)
try {
  const require = createRequire(path.join(asar, 'node_modules', 'sharp', 'package.json'))
  const sharp = require('sharp')
  console.log(`SHARP LOADED OK: ${typeof sharp}`)
  setTimeout(() => {
    console.log('PROBE RESULT: PASS (sharp loads inside packaged app)')
    process.exit(0)
  }, 300)
} catch (error) {
  console.log(`SHARP LOAD FAILED: ${error.message}`)
  console.log(`code: ${error.code}`)
  console.log('PROBE RESULT: FAIL (sharp unusable inside packaged app)')
  process.exit(1)
}
