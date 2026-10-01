# IPC 契约

进程间调用分三层。三层必须同时更新。

| 层 | 文件 | 内容 |
|---|---|---|
| 1. 通道名 | `packages/shared/IpcChannel.ts` | 通道字符串的唯一来源 |
| 2. handler | `src/main/ipc.ts`、`src/main/kernel/index.ts` | 主进程实现 |
| 3. 桥 | `src/preload/index.ts` | contextBridge 暴露面 |

## 规则

- 新增或删除通道时，同一处改动里更新三层。
- 在主进程 handler 里校验全部输入。不要把 Node API 暴露给渲染层。
- 内核通道（`dsh:*`）保持 handler 薄：只做参数整形与登记，工作交给 `ctx.topicTree`、
  `ctx.sessionGC`、`ctx.reasoning` 这些服务缝。
- 渲染层的调用点只经 `window.api`。不要直接 `ipcRenderer.invoke`。

## 通道分组

| 前缀 | 内容 | 实现在 |
|---|---|---|
| `dsh:` | 内核：话题、发送、停止、事件、provider 同步、会话事件 | `src/main/kernel/index.ts` |
| `codeCli:` | 编码助手：二进制、工具状态、配置 | `src/main/ipc.ts` |
| `mcp:` | MCP 服务器管理 | `src/main/ipc.ts` |
| `file:` / `fs:` | 文件仓与文件系统 | `src/main/ipc.ts` |
| `trace:` | trace 窗口与 span 查询 | `src/main/ipc.ts` |
| 其他 | 应用信息、窗口、备份、导出、设置同步 | `src/main/ipc.ts` |

## 内核通道的两条约定

1. **发送与事件分开**。渲染层上行用发送通道，下行靠会话事件广播。不要为单条消息加查询通道。
2. **停止是话题级的**。`dsh:topic-stop` 先中止该话题下主进程登记的长活，再让内核收尾。
   不要按消息 id 停止。

## 门禁覆盖与人工核对

静态套件查引用、符号、语法、配置、i18n 与包闭包。它**不**交叉核对上面三层。
新增通道时人工核对：通道名已声明、主进程已注册、preload 已暴露、渲染层调用点已接线。

渲染层的孤儿通道（声明了但没人调用）不会被门禁发现。发现一条就删一条。
