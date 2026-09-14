import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

import electronViteConfig from './electron.vite.config'

const mainConfig = (electronViteConfig as any).main
const rendererConfig = (electronViteConfig as any).renderer

export default defineConfig({
  test: {
    projects: [
      // 主进程单元测试配置
      {
        extends: true,
        plugins: mainConfig.plugins,
        resolve: {
          alias: mainConfig.resolve.alias
        },
        test: {
          name: 'main',
          environment: 'node',
          setupFiles: ['tests/main.setup.ts'],
          include: ['src/main/**/*.{test,spec}.{ts,tsx}', 'src/main/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['src/main/**/*.bench.{ts,tsx}', 'src/main/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // 渲染进程单元测试配置
      {
        extends: true,
        plugins: rendererConfig.plugins.filter((plugin: any) => plugin.name !== 'tailwindcss'),
        resolve: {
          alias: rendererConfig.resolve.alias
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['@vitest/web-worker', 'tests/renderer.setup.ts'],
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}', 'src/renderer/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['src/renderer/**/*.bench.{ts,tsx}', 'src/renderer/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // 脚本单元测试配置
      {
        extends: true,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.{test,spec}.{ts,tsx}', 'scripts/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
          benchmark: {
            include: ['scripts/**/*.bench.{ts,tsx}', 'scripts/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      },
      // shared 包单元测试配置
      {
        extends: true,
        resolve: {
          alias: {
            '@shared': resolve('packages/shared')
          }
        },
        test: {
          name: 'shared',
          environment: 'node',
          include: [
            'packages/shared/**/*.{test,spec}.{ts,tsx}',
            'packages/shared/**/__tests__/**/*.{test,spec}.{ts,tsx}'
          ],
          benchmark: {
            include: ['packages/shared/**/*.bench.{ts,tsx}', 'packages/shared/**/__tests__/**/*.bench.{ts,tsx}']
          }
        }
      }
    ],
    // 全局共享配置
    globals: true,
    setupFiles: [],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**',
        '**/coverage/**',
        '**/tests/**',
        '**/.vscode/**',
        '**/.github/**',
        '**/*.d.ts',
        '**/types/**',
        '**/__tests__/**',
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.config.{js,ts}'
      ]
    },
    testTimeout: 20000,
    // 用 forks 池取代默认的 threads 池（v0.3.0-1 后续，实测取证）：
    // 本机 14 逻辑核 → threads 池会起约 13 个 worker 线程，在 Windows 上会让 vitest 进程以原生
    // 访问违例（0xC0000005；PowerShell 记 -1073741819）收尾——**测试本身始终全过**，但退出码被毁，
    // `pnpm test` 与 `pnpm build:check` 因此永远不绿。取证（同一测试集、同一台机器）：
    //   · threads（默认并发）：4 次全崩（崩点不定：汇总行之前或之后）；renderer 单项目也崩；
    //   · threads + poolOptions.threads.maxThreads=4：仍崩（124 文件 / 2240 测试全过，退出码仍为违例）；
    //   · --pool=forks：连续 2 次 exit 0（71.3s / 65.0s）—— **且比 threads 的 88.5s 更快**。
    // main / scripts / shared 在两种池下都干净，崩溃只见于 renderer × threads 这一组合；故判定为环境层
    // 间歇性原生崩溃（非测试失败、非本版代码引入）。详见 docs/v0.3.0-1_doc.md §13.3 与 §15.1。
    pool: 'forks'
  }
})
