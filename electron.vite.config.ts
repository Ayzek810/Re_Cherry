import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import react from '@vitejs/plugin-react-swc'
import { CodeInspectorPlugin } from 'code-inspector-plugin'
import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

// assert not supported by biome
// import pkg from './package.json' assert { type: 'json' }
import pkg from './package.json'
import { buildProxyBootstrapPlugin } from './scripts/buildProxyBootstrapPlugin'

const visualizerPlugin = (type: 'renderer' | 'main') => {
  return process.env[`VISUALIZER_${type.toUpperCase()}`] ? [visualizer({ open: true })] : []
}

/**
 * 构建期不变式：**产物里不得出现 `delete require.cache[...]`**。
 *
 * 起因（2026-10-01 真机实锤，整条链已定位）：`electron-store` 的模块体里有一句
 * `delete require.cache[__filename]`（它用 `module.parent` 推 parentDir）。该包此前被写在
 * devDependencies 里，而主进程构建只把 root `dependencies` 列为 external——于是它被
 * **内联进入口文件**，`__filename` 就变成入口自己的路径：**入口被从 Node 模块缓存里删掉**。
 * 之后任何 chunk 的 `require("../index.js")` 都变成缓存未命中 → 整份入口重跑一遍
 * （入口 chunk 里有 5 个回指它的 chunk）= 同一进程跑 5 次启动序列：`app:info` 二次注册、
 * `dsh:sync-providers` 二次注册导致内核启动失败、两个 logger 抢同一日志文件（退出 `write after end`）、
 * userData 被反复追加 "Dev"。
 *
 * 修法有两半：① `electron-store` 移入 root `dependencies`，构建自动 external、打包也会收集；
 * ② 这里做**构建期红灯**——只要产物里还有谁在删模块缓存，立刻失败，而不是留到真机上看启动循环。
 */
function forbidModuleCacheTamperingPlugin() {
  return {
    name: 'rec-forbid-module-cache-tampering',
    closeBundle(): void {
      const mainDir = resolve('out/main')
      let names: string[]
      try {
        names = readdirSync(mainDir, { recursive: true }) as string[]
      } catch {
        return // 产物尚未生成，没有可检查的对象
      }
      const offenders: string[] = []
      for (const name of names) {
        const fileName = String(name)
        if (!fileName.endsWith('.js')) continue
        const text = readFileSync(join(mainDir, fileName), 'utf8')
        if (/delete\s+require\.cache|require\.cache\s*\[[^\]]*\]\s*=/.test(text)) offenders.push(fileName)
      }
      if (offenders.length > 0) {
        throw new Error(
          'bundled main bundles must not tamper with require.cache (inlined CJS packages that do will evict ' +
            `the entry module and re-run the whole boot): ${offenders.join(', ')}`
        )
      }
    }
  }
}

const isDev = process.env.NODE_ENV === 'development'
const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    plugins: [
      ...visualizerPlugin('main'),
      forbidModuleCacheTamperingPlugin(),
      buildProxyBootstrapPlugin({
        dependencies: Object.keys(pkg.dependencies),
        isProd,
        rootDir: __dirname
      })
    ],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@types': resolve('src/renderer/src/types'),
        '@shared': resolve('packages/shared'),
        '@logger': resolve('src/main/services/LoggerService'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
        '@mcp-trace/trace-node': resolve('packages/mcp-trace/trace-node')
      }
    },
    build: {
      rollupOptions: {
        // 三入口：index = 主进程；localOcrWorker = LocalPaddle OCR utility 子进程；
        // visionWorker = 视觉模型文档处理的光栅化子进程。
        // （PDF 文本层抽取已回到主进程内的共用抽取引擎——旧 pdfExtractWorker 入口已删除：
        //  那条路落在 pdfjs 判定"非 Node"的 utility 环境里，DOM 全局补不上，见 extractors.ts。）
        // 多入口下 rollup 不允许 inlineDynamicImports——内部动态导入按 chunk 拆分
        // 到 out/main/，electron-builder files "**/*" 全量打包，无 §4.16 闭包缺口；
        // 外部依赖照旧 externalize，不产生额外 chunk）。
        input: {
          index: resolve('src/main/index.ts'),
          localOcrWorker: resolve('src/main/services/preprocess/localPaddle/localOcrWorker.ts'),
          visionWorker: resolve('src/main/services/preprocess/vision/visionWorker.ts')
        },
        external: ['bufferutil', 'utf-8-validate', 'electron', ...Object.keys(pkg.dependencies)],
        output: {
          format: 'cjs', // 主进程 bundle 形态（与单入口时代一致；package.json 无 "type" 字段）
          // 资产去哈希 + 分位放置：@napi-rs/canvas 原生加载器按字面路径
          // require('./skia.win32-x64-msvc.node')（相对 chunk 目录），哈希名或
          // 错位都会让 GlobalFonts 变 undefined（真机 2026-09-22 实锤）——skia.node
          // 必须与引用它的 chunk 同目录；icon/tray png 的加载器在 index.js（根）。
          assetFileNames(assetInfo): string {
            return (assetInfo.names?.some((n) => n.endsWith('.node')) ?? false)
              ? 'chunks/[name][extname]'
              : '[name][extname]'
          },
          manualChunks: undefined
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        }
      },
      sourcemap: isDev
    },
    esbuild: isProd ? { legalComments: 'none' } : {},
    optimizeDeps: {
      noDiscovery: isDev
    }
  },
  preload: {
    plugins: [
      react({
        tsDecorators: true
      })
    ],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core')
      }
    },
    build: {
      sourcemap: isDev
    }
  },
  renderer: {
    // Hyper-V/WSL 的保留端口段会随重启漂移：5173 曾落在 5141-5240，5270 后来又落进 5245-5344
    // （`netsh interface <ipv4|ipv6> show excludedportrange protocol=tcp` 可查）。
    // 默认端口选在保留段之外，并可用 DSH_DEV_PORT 覆盖；仅开发环境生效，生产构建不使用 server 配置。
    server: {
      port: Number(process.env.DSH_DEV_PORT) || 5870,
      strictPort: true
    },
    plugins: [
      (async () => (await import('@tailwindcss/vite')).default())(),
      react({
        tsDecorators: true
      }),
      ...(isDev ? [CodeInspectorPlugin({ bundler: 'vite' })] : []), // 只在开发环境下启用 CodeInspectorPlugin
      ...visualizerPlugin('renderer')
    ],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('packages/shared'),
        '@types': resolve('src/renderer/src/types'),
        '@logger': resolve('src/renderer/src/services/LoggerService'),
        '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
        '@mcp-trace/trace-web': resolve('packages/mcp-trace/trace-web')
      }
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext' // for dev
      }
    },
    worker: {
      format: 'es'
    },
    build: {
      target: 'esnext', // for build
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          miniWindow: resolve(__dirname, 'src/renderer/miniWindow.html'),
          traceWindow: resolve(__dirname, 'src/renderer/traceWindow.html')
        },
        onwarn(warning, warn) {
          if (warning.code === 'COMMONJS_VARIABLE_IN_ESM') return
          warn(warning)
        }
      }
    },
    esbuild: isProd ? { legalComments: 'none' } : {}
  }
})
