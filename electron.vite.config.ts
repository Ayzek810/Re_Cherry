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

const isDev = process.env.NODE_ENV === 'development'
const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    plugins: [
      ...visualizerPlugin('main'),
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
        // 双入口：index = 主进程；ocrWorker = OCR worker 线程（多入口下 rollup
        // 不允许 inlineDynamicImports——内部动态导入按 chunk 拆分到 out/main/，
        // electron-builder files "**/*" 全量打包，无 §4.16 闭包缺口；外部依赖
        // 照旧 externalize，不产生额外 chunk）。
        input: {
          index: resolve('src/main/index.ts'),
          ocrWorker: resolve('src/main/services/localModel/ocrWorker.ts')
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
