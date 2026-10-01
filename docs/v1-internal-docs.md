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

0.5.2 冻结时基线（空闲机器终验）：**双 typecheck 0/0 · oxlint 0/0 · eslint 0 error · biome format/lint 0 ·
静态 10/10 · vitest 369 文件 3650 用例全绿 · electron-vite build 成功**。
（0.5.0 冻结时为 234 文件 3064 用例；用例数的增长来自第二轮审查为每条修复补的行为测试。）

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
验证「窗口创建 → `#root` 挂载 → 外壳渲染 → 新 IPC 可达」。

两条验证路径与各自判据（2026-10-01 0.5.2 实测校准）：

| 路径 | 命令 | 判据 |
|------|------|------|
| CDP 冒烟（已构建产物） | `RC_REMOTE_DEBUG_PORT=<port>` 启动应用，另开终端 `node tools/smoke-cdp.cjs <port>` | **只认** `rootMounted` / `apiBridge` / `mcpCheckCommand` / `errors` 为空四项。脚本里的 `hasSidebar` / `hasMainContent` 是启发式选择器，本应用是 div + styled-components（`aside`/`nav` 命中数为 0），这两个字段恒为 false，**不作为判据** |
| Playwright e2e | `pnpm playwright test`（`tests/e2e`） | `tests/e2e/specs/app-launch.spec.ts` + `navigation.spec.ts` 全绿；导航用例即「懒路由在 `file://` 下真的能加载」的证据 |

「UI 真的渲染出来了」怎么判：不要看上面的启发式字段，去读窗口里的实际内容——本轮实测为
`首页 / 助手 / 话题` 三栏 + 助手列表 + 输入栏，**26 个按钮 / 3 个输入框 / 46 个 SVG**，
`document.documentElement.lang = zh-CN`，无错误边界文案。

> 2026-10-01 修掉的一个测试装置缺陷：`tests/e2e/fixtures/electron.fixture.ts` 原先在 Playwright 连上 CDP
> **之后**才 `waitForEvent('window')`，而主窗口往往已经建好 ⇒ 事件错过 ⇒ 7/7 用例 60s 超时（应用本身正常）。
> 现改为「先看 `electronApp.windows()` 里已存在的窗口，找不到再等新窗口事件」，修后 7/7 通过（1.3 分钟）。
> 教训：e2e 全红时先分清「应用坏」与「装置坏」——用 CDP 冒烟独立取证。

## 4. 变更清单（按轮次与主题）

三个版本都是「正式版（1.0.0）之前的整理」，所以这份清单按**主题**归并，不按提交罗列。
发布说明以 `electron-builder.yml` 的 `releaseInfo.releaseNotes` 为准（那里保留三轮分段内容）。

**本清单不引用提交 SHA。** 历史随时可能改写（改名、压缩、重排），SHA 会失效；文档只描述能力与行为的变化。

### 4.1 第一轮整理（0.5.0）

| 主题 | 内容 |
|------|------|
| 格式与 lint | biome/eslint 机械格式清理（顺带修掉 biome `useSortedClasses` 自动修复删掉字符串拼接边界空格，导致 className 粘连成 `transition-colorsbg-primary`）；oxlint/eslint 全清；`_` 前缀约定编码进 `.oxlintrc.json` |
| 暗病 | 译块水合竞态 · MessageMenubar 陈旧 memo · kernelChat unsafe optional chaining |
| i18n | 3 处模板键改 Record 映射并收紧动态键注册表；孤儿键 257 个双语同步删除 |
| 性能 | 路由级懒加载 + MathJax 懒加载 + shared barrel 泄漏修复 + xlsx 动态导入 ⇒ 首屏 eager **21.25MB → 14.14MB（−33%）**，`store` chunk 7.93 → 5.31MB |
| MCP 页 | 运行时依赖页诚实化重写：去掉「永远缺失」假象与 4 个死桩，新增 `Mcp_CheckCommand`；trace 复制按钮由 100ms 轮询改 MutationObserver |
| 文档 | 内部文档 + CLAUDE.md 按 ASD-STE100 重写 + 发布说明 |

### 4.2 第二轮整理（0.5.1）

| 主题 | 内容 |
|------|------|
| E1 取证 | 钩子改为「**任意内核事件**间隔」——思考期与工具期不再被误报成流式停顿 |
| 注入与首屏 | 注入逃逸加固 · KaTeX 退出首屏 · richEditor 命名空间补键（133 键） |
| 门禁 | 动态键形状登记，堵住 i18n 模板键的静态检查盲区 |
| 修复批次 | 未闭环项 51 项，按 8 个文件所有权分区并行落地，每项自带测试与台账 |

### 4.3 第三轮整理（0.5.2）

第二轮全量审查的 **337 条发现逐条给出终局结论**（修复 / 复核不成立 / 有意保留，尾部为 0）。
要点：

- 渲染与状态：设置订阅按字段化（`useSetting`，消息树 6 个热路径消费者不再订阅整片 settings）·
  血缘索引 O(n)（含旧算法差分对照）· Shiki 语言 chunk 去重（−4.14MB）· Notion 与 OTel 退出首屏
- 正确性：删除路径三态消费 · 迁移失败语义（9 个无保护分支收口 + 修正一处写错的迁移键）·
  `purgeFailures` 终于被消费 · 能力标签组从渲染体内联组件提为模块级组件 ·
  `getProviderByModel` 三值化（唯一实现 + 显式失败）
- 功能补口：自定义小应用「缺失 / 读不出来」三态区分（新增一条三态 IPC，三层同步）·
  mini 窗在途取消收敛为单一判据 · 笔记防抖实例唯一化（改名/移动后不再按旧路径复活文件）
- 清理：API 网关租约三件套与其 `'deferred'` 态、恒 false 的生命周期字段、零调用工具函数；
  测试临时目录不再外溢到仓库根
- 实机验证：CDP 冒烟 + Playwright e2e（7/7，含 `#/settings`、`#/files` 两条懒路由导航），
  方法与判据见 §3

## 5. 性能基线与复测方法

| 指标 | v0.4.7 | 0.5.1 | 0.5.2 |
|------|--------|--------|--------|
| 首屏取回面（FACE A，`index.html` 列出的全部资源） | — | 12,781,986 B | **12,373,794 B** |
| 首屏执行闭包（FACE B，entry 的静态导入闭包） | — | 12,594,070 B | **12,185,742 B** |
| 首屏 eager（rendered，早前口径） | 21.25 MB | 14.14 MB | 14.14 MB |
| `store` chunk（产物） | 7.93 MB | 2,394,934 B | **2,051,058 B** |
| 小窗首屏面 / 执行闭包 | — | 10,202,996 / 10,045,675 B | **9,361,193 / 9,203,736 B** |
| 重复 Shiki 语言 chunk（每种语言的第二份副本） | — | 4,355,971 B | **13,218 B** |
| JS 资产总数 / 总体积 | 790 / 52.3 MB | 1,205 / 58.183 MB | **896 / 51,222,316 B raw** |
| 首屏 mathjax-full / pdf-parse / xlsx | 2.28 / 0.82 / 0.55 MB | 0（懒加载） | 0（懒加载） |

FACE A 与 FACE B 的区别：FACE A 是浏览器为首屏**取回**的字节（含 Vite 为动态导入写的 `modulepreload`
提示，故可含懒 chunk）；FACE B 是首屏必须**解析并执行**的字节。静态值导入改动态导入只动 FACE B；
chunk 离开 `modulepreload` 列表才动 FACE A。复测：`node tools/audit2-fixes/measure-eager.cjs`（只读 `out/renderer`，
输出 FACE A/B、逐窗口 chunk 清单、按内容指纹的命名资产、语言 chunk 重复统计）。构建产物由 `electron-vite build` 生成。

按包归因的旧方法（一次性，不改仓库默认配置）：把 `electron.vite.config.ts` 的 `visualizerPlugin` 临时改成
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

### 6.1 第二轮全量审查的收敛（337 条）

第二轮审查跨 10 个分区产出 **337** 条发现，逐条台账在 `reports/audit2/*.md`，修复台账在
`reports/audit2-fixes/*.md`。**每一条都必须有终局结论**，只允许三态：`FIXED`（附证据）/
`NOT-A-PROBLEM`（附证据，说明为什么不是问题）/ `WONTFIX`（附条款，说明为什么不改）。
不含结论的条目会出现在尾部清单里——这是唯一「真没做完」的部分。

- 汇总表：`reports/audit2-closure.md`，用 `node tools/audit2-closure.cjs` 重新生成。
  **尾部必须为 0**（该脚本尾部计数是台账级校验，不是质量校验；质量由门禁负责）。
- 两轮台账互相打架、或二轮漏登的条目，由人工裁定表 `reports/audit2-fixes/final-adjudication.md`
  给出最终结论（脚本给它最高优先级）。
- 裁定纪律：**「转交他区」不是结论**。跨区项要么落地，要么按条款记 `WONTFIX`。

## 7. 数据与迁移

- redux-persist `version: 228`（`store/index.ts` 与 `store/migrate.ts` 最高键必须同步）。
- Dexie 表结构见 `src/renderer/src/databases/index.ts` 的 `db.version(n).stores`。
- 内核会话日志、`topics.json` 注册表、`provider-keys.json` 是重启后状态的三个权威落点；
  渲染层 localStorage 只承载可重建的 UI 态。
