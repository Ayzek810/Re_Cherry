# Re_Cherry v1 内部文档

> 版本定位：v1 = 全量代码优化 + 暗病审查 + 性能轻量化 + 部署测试 + 内部文档 + 开发遗产清理 + 正式上线。
> 本轮文档写于 v1 冻结期（2026-10-01），与 `CLAUDE.md`（给 AI/开发者的工程指南）互补：
> 本文是**交付与运维视角**的快照。

## 1. 架构快照（v1 定稿）

```
src/
  main/          Electron 主进程 —— 承载 DSH 内核（src/main/kernel/）
  renderer/      React SPA（components/ databases/ hooks/ pages/ services/ store/ types/ utils/ windows/ workers/）
  preload/       contextBridge IPC → window.api
packages/
  shared/        跨进程类型、常量、IPC 通道定义
  mcp-trace/     OpenTelemetry trace-core + node/web 适配器（活特性，包名为历史遗留）
```

- 入口链：`src/main/index.ts` → `bootstrap.ts`（数据目录重定向）→ `kernel/index.ts`（内核启动）+ `ipc.ts` → `windowService.createMainWindow()`。
- 渲染入口链：`index.html` → `entryPoint.tsx` → `init.ts` → `App.tsx` → `Router.tsx`（**v1 起路由级分包**）。
- 三窗口：`index.html`（主窗）· `miniWindow.html`（快捷助手）· `traceWindow.html`（trace 栈）。
- 真相源唯一：内核会话日志（SQLite `{userData}/kernel/sessions.db`）；渲染层是投影。
- 密钥：`{userData}/provider-keys.json`（`ProviderKeyStore` 加密落盘，rehydrate 后回填）。

**v1 新增/变更的结构点**（详见第 4 节）：
- 渲染层路由级懒加载 + `RouteLoadingFallback` 骨架（`Router.tsx`）。
- MathJax 插件懒加载（`pages/home/Markdown/Markdown.tsx`），默认引擎 KaTeX 不加载该闭包。
- MCP 运行时依赖页重写 `pages/settings/MCPSettings/McpRuntimeDependencies.tsx` + 新 IPC `Mcp_CheckCommand`。
- `packages/shared/utils/index.ts` 不再 re-export `./pdf`（barrel 泄漏修复）。

## 2. 门禁（每批次必跑，顺序即依赖）

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node ≥24.11.1
$env:CI = "true"

# 1) 类型（必须带 --composite false，否则会伪造 TS4023/TS2742 并往 src/ 吐 ~2000 个 .js/.d.ts）
node_modules\.bin\tsgo --noEmit -p tsconfig.node.json --composite false
node_modules\.bin\tsgo --noEmit -p tsconfig.web.json  --composite false
# 2) Lint 三件套
node_modules\.bin\oxlint --deny-warnings
node_modules\.bin\eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts
node_modules\.bin\biome format ; node_modules\.bin\biome lint
# 3) 静态套件（10 项，住在仓库外）
node E:\Workspace\project_REC\tools\static-checks\run-all.js
# 4) 测试（forks pool）
node_modules\.bin\vitest run --silent
# 5) 构建
node_modules\.bin\electron-vite build
```

v1 冻结时基线：**双 typecheck 0/0 · oxlint 0/0 · eslint 0/0 · biome 0/0 · 静态 10/10 · vitest 234 文件 3064 用例全绿 · electron-vite build 成功**。

> 沙箱注记：`pnpm`/vitest/electron-vite 需要能 spawn 子进程并收割输出；受限策略下会 `spawn EPERM`，
> 此时用本文件里的直接二进制路径（同步改造：`node_modules\.bin\*`）。

## 3. 部署与发布

```powershell
# 正式打包（--publish never 不可省：CI 模式会尝试 GitHub publish 并失败）
pnpm build:win:x64 --publish never
```

产物（`dist/`）：`Re_Cherry-<版本>-x64-setup.exe`（NSIS 安装器）· `Re_Cherry-<版本>-x64-portable.exe` · `win-unpacked/`。

发布前必看：
- `scripts/after-pack.js` 对原生闭包（onnxruntime/sharp/ppu-* 与 `@img/*`）有**交付断言**——安装版 OCR 死过
  一次（v0.4.3 及之前 `sharp` 静默缺失），该断言必须保持为红即停。
- `electron-builder.yml` 的 `releaseInfo.releaseNotes` 每次发布同步更新（v1 起改为当前版本）。
- 版本号三处一致：`package.json`、`electron-builder.yml` 产物名（引用 `${version}`，自动）、git tag。

**装机冒烟（v1 采用的零依赖手法）**：主进程留了 CDP 门 `RC_REMOTE_DEBUG_PORT`，端口注入后可用任意 CDP 客户端
验证「窗口创建 → `#root` 挂载 → 侧栏/会话页存在 → 新 IPC 可达」。

## 4. v1 变更清单（按提交）

| 批次 | 提交 | 内容 |
|------|------|------|
| 1 | `99b0633` | biome/eslint 机械格式清理；**顺带修掉 biome `useSortedClasses` 自动修复删掉字符串拼接边界空格**导致 className 粘连（`transition-colorsbg-primary`） |
| 2 | `ba6438d` | lint 卫生收口（oxlint/eslint 全清）+ 3 处暗病（译块水合竞态、MessageMenubar 陈旧 memo、kernelChat unsafe optional chaining）+ 动态 i18n 键显式化（3 处模板键 → Record 映射，注册表同步收紧）+ `_` 前缀约定编码进 `.oxlintrc.json` |
| 3 | `84616e8` | 性能：路由级懒加载 + MathJax 懒加载 + shared barrel 泄漏修复 + xlsx 动态导入；**首屏 eager 21.25MB → 14.14MB（−33%）**，`store` chunk 7.93 → 5.31MB |
| 4 | `fbccfb6` | MCP 运行时依赖页诚实化重写（去「永远缺失」假象与 4 个死桩，新增 `Mcp_CheckCommand`）+ trace 复制按钮 100ms 轮询改 MutationObserver |
| 5 | 本轮 | 孤儿 i18n 键清理（257 键双语同步删除，2700 → 2443 叶键）+ 文档 + 发布 |

审查台账（含证据与仍保留项）另存 `reports/v1-audit-ledger.md`。

## 5. 性能基线与复测方法

| 指标 | v0.4.7 | v1 |
|------|--------|-----|
| 首屏 eager（rendered） | 21.25 MB | **14.14 MB** |
| 首屏应用代码 | 4.06 MB | 2.64 MB |
| `store` chunk（产物） | 7.93 MB | 5.31 MB |
| 首屏 mathjax-full / pdf-parse / xlsx | 2.28 / 0.82 / 0.55 MB | 0（懒加载） |
| JS 资产总数 / 体积 | 790 / 52.3 MB | 849 / 51.7 MB |

复测方法（一次性，不改仓库默认配置）：把 `electron.vite.config.ts` 的 `visualizerPlugin` 临时改成
`visualizer({ open: false, filename: 'stats-renderer.json', template: 'raw-data' })`，`VISUALIZER_RENDERER=true`
跑 `electron-vite build`，再用工作区脚本归因：
`tools/bundle-attribution.cjs`（chunk 排序）· `tools/bundle-packages.cjs`（按包聚合）· `tools/bundle-eager.cjs`（首屏面构成）。
**测完还原配置并删除 `stats-renderer.json`**（v1 已如此处理）。

## 6. 审计结论摘要（v1 全量审查）

- **静默失败**：主进程 69 处 `.catch(() => {})` 逐条核实，全部是正当清理（临时目录/parser/zip）或有注释说明的
  队列/探针语义——无违规。
- **日志纪律**：`src/main` 内只有 `LoggerService` 自身使用 `console.*`——无违规。
- **定时器/监听**：全部常驻定时器均有清理；唯二空转项已处理（trace 100ms 轮询改 MutationObserver）或
  记录为有意保留（`ProxyManager` 60s 系统代理轮询、`dataLimit` 10min 配额检查）。
- **死文件**：解析器式扫描 + 逐一核实，**无死文件**；两处「无 import」是环境模块增强（`kernelContentBlocks.ts`、
  `table-plus/types.ts`），靠 tsconfig include 生效；worker 由 `?worker` 后缀与构建入口引用。
- **孤儿 i18n 键**：全量扫描 → 动态前缀/对象值命名空间（appMenu/common/tray）保护 → 删 257 键；删除动作由
  `check-i18n-keys` / `check-main-i18n` / `check-i18n-parity` 三重自校验兜底（若误删仍被字面引用，门禁变红）。
- **有意保留（勿「顺手修」）**：`lodash` CJS（0.47MB，别名需新增依赖，收益不足）；`@shikijs/langs` 全量语言表
  （按语言分 chunk 懒加载，换 web 子集可省 6–8MB 磁盘但冷门语言退化）；`ComposerToolRuntime` 的三个 V2 对位空壳
  （有真实消费方）；`ImageViewer` 的 `_` 前缀弃用 props（antd 兼容 shim）。

## 7. 数据与迁移

- redux-persist `version: 228`（`store/index.ts` 与 `store/migrate.ts` 最高键必须同步）。
- Dexie 表结构见 `src/renderer/src/databases/index.ts` 的 `db.version(n).stores`。
- 内核会话日志、`topics.json` 注册表、`provider-keys.json` 是重启后状态的三个权威落点；
  渲染层 localStorage 只承载可重建的 UI 态。
