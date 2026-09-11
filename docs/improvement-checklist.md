# Re_Cherry 改进清单

> ⚠️ **v0.2.4-1 清理后更正（2026-09）**：本清单成稿于 v0.2.4 之前，部分清单项经引用链复核后**判定错误**，勿照单执行：
> - `AssistantSettings.toolUseMode` **不是死字段**（`utils/assistant.ts:isToolUseModeFunction` 活用于 UrlContextbutton；UI 在 AssistantModelSettings / DefaultAssistantSettings；migrate 有 7 处分支）。**不能删**。
> - `anthropicApiHost` **不是零消费**（ProviderSetting UI + providerHost.ts + isAnthropicSupportedProvider 均活）；只有**内核**零消费。**不能删**。
> - trace/OpenTelemetry 全链与 Pyodide 是**活功能**，勿按“MCP 已砍”推断删除。
> - 本文件内所有 TODO/FIXME 行号在 v0.2.4-1 大规模清理后已大量漂移，定位请重新 grep。
> - v0.2.4-1 已完成的主要清理：见工作区 `docs/v0.2.4-1_doc.md`。
> - 开头的 `agent-assistant-fields-report.md` 在仓库与工作区均不存在（已被删除的中间产物）。

> 整理日期：2026-09-04
> 基于：`docs/work-mode-evolution.md`、代码 TODO/FIXME 扫描、核心源码阅读（原列出的 `agent-assistant-fields-report.md` 已不存在，见上方更正）

---

## 目录

1. [功能演进（大颗粒）](#1-功能演进大颗粒)
2. [代码债务（TODO/FIXME）](#2-代码债务todofixme)
3. [架构与设计问题](#3-架构与设计问题)
4. [类型安全与工程质量](#4-类型安全与工程质量)
5. [v2 迁移阻塞项](#5-v2-迁移阻塞项)

---

## 1. 功能演进（大颗粒）

### 1.1 工作模式（Work Mode）— ⚠️ 设计定稿，待实施

来源：`docs/work-mode-evolution.md`

这是当前最大的待实施功能，目标是在单一聊天页实现 Agent 能力的可开关化。

#### Phase 0：地基（Schema 改造）
- [ ] **删除死字段**：`Assistant.mcpMode`、`Assistant.mcpServers`、`AssistantSettings.maxToolCalls`、`AssistantSettings.enableMaxToolCalls` 及全部引用（**`toolUseMode` 不删——见文首更正，它是活字段**）
- [ ] **Assistant 新增字段**：
  - `workModeDefault: boolean` — 新话题默认是否开启工作模式
  - `accessiblePaths: string[]` — 默认工作区路径列表
  - `approvalMode: 'ask' | 'workspace-auto' | 'full-access'` — 权限审批档位
- [ ] **KernelTopic 同步三字段**：`topics.json` schema 扩展，旧话题缺字段默认折叠（off / [] / 'ask'）
- [ ] **验证**：`pnpm build:check` 通过；旧话题正常打开、历史渲染正常

#### Phase 1：点亮工具卡片（Projection + Approval 往返）
- [ ] **kernelChat 投影 `tool/call`、`tool/result`**（含历史还原 `projectEventsToMessages`）
  - `tool/call` → 新建 `ToolMessageBlock`（toolId=callId、status=STREAMING）
  - `tool/result` → 更新同块（content、status=SUCCESS/ERROR）
- [ ] **Approval IPC 往返**：
  - preload 新增 `dshApproval*` API
  - `IpcChannel` 新增审批通道
  - 内核 approval 服务挂接
  - 卡片等待态复用 `ToolBlockGroup.getBlockIsWaiting`
- [ ] **端到端验证**：挂 `dsh-tool-ask-user`  harmless 工具验证

#### Phase 2：工作模式开关（UI + 状态机）
- [ ] **`'cherry/work-mode'` 会话事件**：通过 declaration merge 加入 `SessionEventMap`
- [ ] **pre-step 折叠逻辑**：active → 注册工具 schema + 注入提示词；off → tools.restrict 空集
- [ ] **InputbarTools 右侧插槽**：工作模式 Switch（pending / 已生效两态）
- [ ] **助手设置新增"工作模式"一节 UI**：三项（默认开关、工作区、审批档位）
- [ ] **验证**：流中可拨、下一轮生效；重启后自恢复；新话题继承助手默认

#### Phase 3：真工具落地（fs + 工作区 + 审批）
- [ ] **引入 `@deepseek-ai/dsh-tool-fs`**、`dsh-fs-local`、`dsh-fs-observation-policy`
- [ ] **工作区生效**：`accessiblePaths` → `workspaceRoot`；`SessionWorkspaceMeta` + 外开编辑器按钮
- [ ] **审批三档映射到 dsh 原语**：
  | 档位 | approval | sandbox |
  |---|---|---|
  | ask | ask | read-only |
  | workspace-auto | 放行 | workspace-write |
  | full-access | never | danger-full-access |
- [ ] **验证**：模型可读写工作区文件并出卡片；三档行为正确；模式关闭后 UNKNOWN_TOOL 拒绝

#### Phase 4：完备（bash/pwsh + 沙箱 + 命令）
- [ ] **引入 `dsh-tool-bash`/`dsh-tool-pwsh`** + local/sandbox 后端
- [ ] **沙箱三件套**（含 windows-acl）
- [ ] **`dsh-commands` 斜杠命令**接入 inputbar 面板
- [ ] **可选**：`dsh-plan-mode`、`dsh-user-questions`

### 1.2 助手与 Agent 设置合并

来源：`agent-assistant-fields-report.md`

- [ ] **统一 prompt/instructions**：`Assistant.prompt` 与 Agent `instructions` 语义相同，需统一词表
- [ ] **MCP 配置合并**：`Assistant.mcpServers` → Agent `mcps`
- [ ] **模型参数映射**：`settings.temperature/topP/maxTokens` ↔ Agent `configuration`
- [ ] **正则短语/斜杠命令映射**：`regularPhrases` ↔ `slash_commands`
- [ ] **记忆开关映射**：`enableMemory` ↔ `configuration.soul_enabled`
- [ ] **清理死代码**：Agent 定义级/会话级 schema 中不再需要的字段

---

## 2. 代码债务（TODO/FIXME）

### 2.1 模型配置层

| 文件 | 行 | 类型 | 内容 |
|---|---|---|---|
| `config/models/openai.ts:19` | TODO | 仅覆盖 GPT 和 reasoning（o-series）模型 |
| `config/models/reasoning.ts:41` | TODO | 重构：太多相同选项 |
| `config/models/reasoning.ts:138` | TODO | 补充单元测试 |
| `config/models/reasoning.ts:327` | TODO | 重命名 |
| `config/models/reasoning.ts:334` | TODO | 合并进 `isSupportedThinkingTokenModel` |
| `config/models/vision.ts:221` | TODO | 优化正则 |
| `config/models/websearch.ts:64` | TODO | 其他供应商采用 Response 端点时需改进逻辑 |
| `config/models/logo.ts:168` | FIXME | 永远为 true，应移除或改为动态获取 |

### 2.2 消息/渲染层

| 文件 | 行 | 类型 | 内容 |
|---|---|---|---|
| `pages/home/Messages/ChatFlowHistory.tsx` (多处) | FIXME | 滥用 `any`，需清理类型 |
| `pages/home/Messages/Messages.tsx:205` | FIXME | error block 没有 content |
| `pages/home/Messages/Tools/MessageTool.tsx:31` | FIXME | 语义错误：已不是 MCP tool，`rawMcpToolResponse` 需更名（涉用户数据迁移） |
| `pages/home/Messages/Blocks/ThinkingBlock.tsx:75` | FIXME | 临时兼容代码 |
| `components/ContextMenu/index.tsx:64` | FIXME | 组件名像通用组件但完全不可定制 |
| `components/CodeBlockView/view.tsx:347` | FIXME | 最小宽度 hack |
| `components/CodeBlockView/view.tsx:397` | FIXME | 滚动条边缘溢出 |
| `components/CodeBlockView/HtmlArtifactsPopup.tsx:38` | FIXME | `stream: true` 避免多余空行（hack） |
| `components/CodeViewer.tsx:131` | FIXME | SelectionToolbar 无法弹出，走剪贴板回退 |

### 2.3 设置与状态层

| 文件 | 行 | 类型 | 内容 |
|---|---|---|---|
| `pages/settings/AssistantSettings/AssistantModelSettings.tsx:232` | TODO | 移除根据模型自动修改参数的逻辑 |
| `pages/settings/ProviderSettings/ProviderSetting.tsx:597` | TODO | 添加 reset 按钮 |
| `store/settings.ts:216` | TODO | 坏命名 `reasoningSummary`，v2 重命名 |
| `types/index.ts:175` | FIXME | `reasoning_effort_cache` 应由外部缓存服务管理，不应存在 assistant 中 |
| `types/index.ts:549` | TODO | MCP 相关类型定义迁移到独立文件 |

### 2.4 其他

| 文件 | 行 | 类型 | 内容 |
|---|---|---|---|
| `main/ipc.ts:240` | TODO | clear logs |
| `types/newMessage.ts:211` | TODO | `providerMetadata` 应加入 MessageBlock 保存每块原始 provider 数据 |
| `types/newMessage.ts:226` | FIXME | `ResponseError` 类型安全弱，运行时可能是 Error 子类 |
| `pages/home/Inputbar/Inputbar.tsx:417` | TODO | 直接用 `assistant.knowledge_bases`，context state 过度设计 |
| `components/Preview/MermaidPreview.tsx:82` | FIXME | mermaid-js 修复后可移除 workaround |
| `services/ShikiStreamService.ts:408` | FIXME | 流式高亮语法状态丢失，降级策略 |
| `components/RichEditor/index.tsx:204` | TODO | 实现自定义 toolbar items |
| `utils/provider.ts:88` | TODO | 等待上游支持 aws-bedrock |
| `utils/json.ts:18` | TODO | `unknown` 替代 `any` |
| `components/Tab/TabContainer.tsx:72` | TODO | TabId 作为类型替代 string |

---

## 3. 架构与设计问题

### 3.1 双事实源风险（已部分解决，但需持续警惕）
- [ ] **内核是权威数据源**：渲染进程仅是投影，任何会话级状态必须从 dsh 会话日志折叠恢复
- [ ] **旧 Dexie IndexedDB 数据**：按既定政策不参与搜索/恢复，但需确保不漂移
- [ ] **`projectEventsToMessages` 完整性**：新增事件类型时必须同步更新投影逻辑

### 3.2 内核层扩展点
- [ ] **ToolRuntime 当前空注册**：`index.ts:102` `mode: 'native'` 但无实际工具，`SystemPrompt.persona: ''`
- [ ] **AgentLoop 空 agents**：`index.ts:131` `{ agents: [] }`，待工作模式接入后填充
- [ ] **事件转发广播**：`registerEventForwarding` 向所有窗口广播，未来多窗口隔离时需改为定向

### 3.3 渲染进程状态管理
- [ ] **`assistants` slice 标记废弃**：头部明确声明 v2 重构中，不接受功能 PR
- [ ] **`messageBlock` slice**：工具块状态管理需与工作模式审批流打通
- [ ] **话题数据缺 name 等问题**：`TopicsHistory.tsx:27` db 中无 topic.name，只能从 store 获取

### 3.4 IPC 与 Preload
- [ ] **审批 IPC 缺失**：当前无 `dshApprovalAsk` / `dshApprovalRespond` 通道（Phase 1 需新增）
- [ ] **preload API 需扩展**：`window.api.dsh*` 系列需增加审批相关方法

---

## 4. 类型安全与工程质量

### 4.1 类型清理
- [ ] **`ChatFlowHistory.tsx` 多处分支**：大量使用 `any`，需逐个清理
- [ ] **`ReasoningEffortOption` 扩展**：与 OpenAI 原语耦合过深，其他供应商适配逻辑分散
- [ ] **`ResponseError` 精确化**：从 `Record<string, any>` 转为联合类型或 branded error

### 4.2 测试覆盖
- [ ] **`reasoning.ts`**：复杂模型推理逻辑缺乏测试（作者 TODO）
- [ ] **`kernelChat.ts`**：事件投影逻辑（尤其是新增 tool 事件后）需补充测试
- [ ] **`topics.ts`**：话题 CRUD、恢复、搜索逻辑需测试

### 4.3 i18n
- [ ] **`i18n/label.ts:140`**：update i18n key
- [ ] **工作模式新增术语**：需全语言翻译（approval mode、workspace、work mode 等）

---

## 5. v2 迁移阻塞项

### 5.1 数据库 Schema
- **IndexedDB（Dexie）**：`src/renderer/src/databases/index.ts`
  - 表：files, topics, settings, knowledge_notes, translate_history, quick_phrases, message_blocks, translate_languages
  - **⚠️ BLOCKED：不可修改 schema 直到 v2.0.0**
- **SQLite（Drizzle）**：`src/main/services/agents/`
  - agents 子系统正在进行 v2 重构

### 5.2 Redux 状态
- **不可新增 slice 或修改现有 state shape 直到 v2.0.0**
- 目前 slice：assistants, settings, llm, mcp, messageBlock, knowledge, paintings, memory, websearch, shortcuts, tabs

### 5.3 标记废弃的文件
以下文件头部带有 `⚠️ NOTICE: V2 DATA&UI REFACTORING` 标记：
- `src/renderer/src/store/assistants.ts`
- 其他含 `@deprecated Scheduled for removal in v2.0.0` 的文件

---

## 优先级建议

| 优先级 | 事项 |
|---|---|
| **P0** | Phase 0 schema 改造（死字段删除 + 新字段添加）— 阻塞后续所有工作 |
| **P1** | `tool/call` + `tool/result` 投影（kernelChat.ts）— 核心能力 |
| **P1** | Approval IPC 往返 — 安全性基础 |
| **P2** | Inputbar 工作模式开关 UI |
| **P2** | 助手设置"工作模式"一节 |
| **P3** | fs 工具落地（Phase 3） |
| **P3** | bash/pwsh 沙箱（Phase 4） |
| **P3** | 代码债务清理（TODO/FIXME）— 可并行 |
| **P4** | 助手-Agent 设置合并 — 需 v2 协调 |

---

## 附录：关键文件速查

| 职责 | 文件 |
|---|---|
| DSH 内核组装 | `src/main/kernel/index.ts` |
| 话题 CRUD | `src/main/kernel/topics.ts` |
| 渲染桥（事件投影） | `src/renderer/src/services/kernelChat.ts` |
| 助手类型定义 | `src/renderer/src/types/index.ts` |
| MessageBlock 类型 | `src/renderer/src/types/newMessage.ts` |
| IPC 通道定义 | `packages/shared/IpcChannel.ts` |
| AssistantSettings UI | `src/renderer/src/pages/settings/AssistantSettings/index.tsx` |
| Inputbar | `src/renderer/src/pages/home/Inputbar/Inputbar.tsx` |
| 工具块渲染 | `src/renderer/src/pages/home/Messages/Blocks/ToolBlockGroup.tsx` |
| 助手 Redux | `src/renderer/src/store/assistants.ts` |
| 默认配置 | `src/renderer/src/services/AssistantService.ts` |
