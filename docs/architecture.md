# 架构

本项目是 Cherry Studio v1.9.11 的精简派生版。消息路径只有一条：进程内的 DSH 内核。
chatbot 与 agent 两套系统已经统一，不再各自维护一条链路。

## 进程模型

| 进程 | 职责 | 关键位置 |
|---|---|---|
| main | Electron 主进程。持有 DSH 内核、全部 IPC handler、所有主进程服务。 | `src/main/` |
| preload | contextBridge。把受控的 `window.api` 暴露给渲染层。 | `src/preload/` |
| renderer | React 单页应用。只投影内核会话日志，不持有会话真相。 | `src/renderer/` |
| utility 子进程 | 按需派生，隔离重活与原生崩溃。见下表。 | `out/main/*Worker.js` |

utility 子进程只有两个入口，各自独立打包：

| 入口 | 用途 |
|---|---|
| `localOcrWorker` | 本机 PaddleOCR 推理（`preprocess/localPaddle/`） |
| `visionWorker` | 视觉模型文档处理的光栅化腿（`preprocess/vision/`） |

通用文件正文抽取不在这里：`readableContent/readableContentWorker.ts` 跑在 `worker_threads` 里，
由 `ReadableContentService` 经 `?nodeWorker` 导入，打包器单独出块。

模块入口图：`src/main/index.ts` → `bootstrap.ts` → `kernel/index.ts` + `ipc.ts` → `windowService.createMainWindow()`。
渲染层入口图：`index.html` → `entryPoint.tsx` → `init.ts` → `App.tsx` → `Router.tsx`。

## 目录地图

```
src/
  main/                     Electron 主进程
    bootstrap.ts            先改数据目录，最先运行
    index.ts                应用入口：建窗口、起内核、注册 IPC
    ipc.ts                  除内核通道以外的全部 IPC handler
    kernel/                 本仓自有的内核集成层（见 kernel-integration.md）
    services/               主进程服务：MCP、知识库、二进制管理、备份、文档处理……
    features/               功能包（API 网关等）
    utils/                  主进程工具
  preload/                  contextBridge
  renderer/                 React 单页应用
    src/pages/              路由页面。首页静态加载，其余路由懒加载
    src/components/         共享组件
    src/services/           渲染层服务（kernelChat、kernelEventStream……）
    src/store/              Redux 切片与持久化迁移
    src/databases/          Dexie 表结构
    src/hooks/ src/utils/ src/types/ src/windows/ src/workers/
packages/
  shared/                   跨进程类型、常量、IPC 通道名
  mcp-trace/                OpenTelemetry trace 内核 + node/web 适配器（在用）
tools/                      开发工具（静态套件、首屏测量、CDP 冒烟）。不进安装包
docs/                       本目录。不进安装包
scripts/                    构建、打包、i18n 脚本
tests/                      单元测试装置与 Playwright 端到端
```

路径别名：`@main` → `src/main/`，`@renderer` → `src/renderer/src/`，`@shared` → `packages/shared/`，
`@types` → `src/renderer/src/types/`，`@logger` → LoggerService（每个进程一份）。

三个 HTML 入口：`index.html`（主窗口）、`miniWindow.html`（快捷助手）、`traceWindow.html`。

## 聊天数据流

一条消息从发送到显示只经过一条路径：

1. 渲染层发送。`window.api.dshTopicSend` → 主进程内核通道。
2. 内核执行一轮。agent 循环产出**会话事件**，并写入内核 SQLite。
3. 内核广播事件。主进程把事件转发给渲染层（`dsh:session-event`）。
4. 渲染层投影。`src/renderer/src/services/kernelChat.ts` 把事件折成 Redux 里的
   `Message` 与 `MessageBlock`。块是显示单元：正文块、思考块、工具块、引用载体块。

事件序列固定为：`turn/start` → `assistant/chunk` ×N → `assistant/message` → `turn/end`。
工具调用另发 `tool/call` 与 `tool/result`。

重开话题时走同一条投影：`loadKernelTopicMessages` 读同一份日志，折出同样的消息与块。
因此渲染层不存会话真相，也不需要在日志之外补状态。

## 渲染层只投影，不裁决

- 会话真相只在内核 SQLite。渲染层的 `messages` / `messageBlocks` 切片不落盘。
- 话题成员资格问内核（`dshTopicList`）。只有"上一次会话留下的行"可以判失效。
- 事件的可见性由一个判据决定：`src/main/kernel/sessionEventView.ts`。它在三个出口生效：
  实时广播、`uiEvents`、搜索。不要在渲染层再加可见性判断。

## 构建产物

| 产物 | 内容 |
|---|---|
| `out/main/index.js` + `out/main/chunks/` | 主进程。外部依赖不打包，运行时从 `node_modules` 解析 |
| `out/main/{localOcrWorker,visionWorker}.js` | utility 子进程入口 |
| `out/preload/index.js` | contextBridge |
| `out/renderer/` | 渲染层。按路由切 chunk，非首页路由懒加载 |
| `out/proxy/index.js` | API 网关的代理引导 |

`electron.vite.config.ts` 决定入口与切分。多入口下 rollup 不允许 `inlineDynamicImports`，
内部动态导入按 chunk 拆分到 `out/main/chunks/`。
