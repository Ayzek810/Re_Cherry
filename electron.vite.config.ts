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
        external: ['bufferutil', 'utf-8-validate', 'electron', ...Object.keys(pkg.dependencies)],
        output: {
          manualChunks: undefined, // 彻底禁用代码分割 - 返回 null 强制单文件打包
          inlineDynamicImports: true // 内联所有动态导入，这是关键配置
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
    // 5173 在本机落在 Windows Hyper-V 保留端口段(5141-5240)内，绑定报 EACCES；
    // dev server 改到保留段之外的固定端口（仅开发环境生效，生产构建不使用 server 配置）。
    server: {
      port: 5270,
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
        '@mcp-trace/trace-web': resolve('packages/mcp-trace/trace-web'),
        '@cherrystudio/extension-table-plus': resolve('packages/extension-table-plus/src')
      }
    },
    optimizeDeps: {
      exclude: ['pyodide'],
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
