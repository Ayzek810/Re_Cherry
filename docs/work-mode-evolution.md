# 统一会话界面演进：工作模式（Agent 能力可开关）

> ⚠️ **v0.2.4-1 更正（实施前必读）**：本文 §3 的 D7 与 §4.4 都把 `AssistantSettings.toolUseMode` 列为"删除的死字段"——**这条已作废**。引用链实测它是**活字段**：`utils/assistant.ts:isToolUseModeFunction` → `UrlContextbutton.tsx:36`（URL context 按钮的语义取决于它）；UI 在 `AssistantModelSettings.tsx:483-489` 与 `DefaultAssistantSettings.tsx:315-322`；`AssistantService.ts:43,176` 提供默认值；`store/migrate.ts` 有 7 处历史分支直接读写它。**Phase 0 只删 `mcpMode`/`mcpServers`/`maxToolCalls`/`enableMaxToolCalls`，不要碰 `toolUseMode`。**
> 同理更正：`anthropicApiHost` 也不是死字段（渲染层 UI/配置活，仅内核零消费）。
> 其余设计（D1-D6、D8、§5 状态机、§6 投影映射、§7 分期）经引用链复核仍然成立。

> 状态：设计定稿，待实施
> 日期：2026-02（v0.2.2 之后）
> 唯一用户制：不做老用户兼容与词表迁就；仅保证已有话题数据"不崩、能开"

## 1. 背景与目标

Re_Cherry 已完成：Cherry Studio v1.9.11 精简 + 消息路径统一为 DSH 内核单路径（chatbot/agent 合流）。

本阶段目标：在**单一聊天页**上实现"工作模式"——同一对话中可随时开关 agent 能力（工具调用），并复用 Cherry 原有的工具卡片机制渲染工具调用。参照物：chatbox 的"工作模式"（会话级开关、按生成周期生效）。

## 2. 总体原则

1. **单路径**：不复活 v1 的 agent 页面/后端；home 页即统一会话界面。
2. **事件溯源税**：一切会话级状态必须能从 dsh 会话日志折叠恢复（v0.2.0~0.2.2 的教训：双事实源必然漂移）。
3. **两层默认值**：助手 = agent 人格模板（存默认值）；话题 = agent 会话实例（可覆盖，覆盖落会话事件）。
4. **正交原语**：UX 保持简单，内核层用 dsh 正交原语组合（approval / sandbox / 工具注册 / 提示词注入）。
5. **故障关闭**：沙箱不可用时宁可拒绝执行，绝不非限制运行。

## 3. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 以 home 页为主体演进（方案 B），不移植 pages/agents | agent 页的壳绑死已删除的 apiServer/Claude Code 后端；其能力（工具卡片、权限切换）大多本就在 home 页 |
| D2 | 设置合并 = 两个关键对象：**工作区** + **权限审批模式**（+默认开关） | 剥离 v1 噪音后 agent 设置的核心；不做两表单拼接 |
| D3 | 工作模式开关 = inputbar 工具栏**右对齐滑动开关**（antd Switch） | 参照 chatbox；一轮对话中便捷切换；按话题独立 |
| D4 | 切换语义：**下一轮生效**（step 边界原子提交） | 与 dsh plan-mode 同构；执行中的工具调用不断刀，保证 tool/call ↔ tool/result 配对 |
| D5 | 模式状态 = 会话日志 log-only 事件 + pre-step 折叠 | resume/fork/重启自动恢复；无需并行存储 |
| D6 | 审批三档直接采用 dsh 沙箱词表 | 唯一用户，无需迁就 v1 的 Claude Code 词表 |
| D7 | 删除死字段 `mcpMode`/`mcpServers`/`maxToolCalls`/`enableMaxToolCalls`（**`toolUseMode` 已更正为活字段，不删**） | 死字段是 schema 的谎言；唯一用户无需迁移。`toolUseMode` 被 `isToolUseModeFunction`（UrlContextbutton）与 7 处 migrate 分支使用 |
| D8 | 分期按"依赖 × 风险"排序，投影链路用无害工具先验证 | approval 往返是最大未知数；fs 先于 bash（爆炸半径） |

## 4. 设置合并设计

### 4.1 助手设置新增"工作模式"一节（仅三项）

| 字段 | 类型 | 含义 | 内核落点 |
|---|---|---|---|
| `workModeDefault` | boolean | 新话题的工作模式默认开关 | 话题创建时继承 |
| `accessiblePaths` | string[] | 默认工作区路径列表 | fs 工具 workspaceRoot / 沙箱根目录 / SessionWorkspaceMeta 显示 |
| `approvalMode` | `'ask' \| 'workspace-auto' \| 'full-access'` | 权限审批档位 | approval policy + sandbox mode 组合 |

### 4.2 审批三档 → dsh 原语映射

| 档位 | approval | sandbox | 含义 |
|---|---|---|---|
| 每次询问 `ask` | ask | `read-only` | 每个工具调用都弹审批卡片 |
| 工作区自动 `workspace-auto` | 放行 | `workspace-write` | 工作区内读写不询问，越界必拦 |
| 全部放行 `full-access` | never | `danger-full-access` | 不再询问 |

### 4.3 会话级覆盖（随话题折叠）

- 工作模式当前状态：inputbar Switch（log-only 事件折叠）
- 后续可加：话题级审批档位/工作区覆盖（暂不做）

### 4.4 删除的死字段

`Assistant.mcpMode`、`Assistant.mcpServers`、`AssistantSettings.maxToolCalls`、`AssistantSettings.enableMaxToolCalls` 及其全部引用。
（**`AssistantSettings.toolUseMode` 不在此列——见文首更正**。）

## 5. 工作模式状态机（范式A：plan-mode 同构）

```
Switch 拨动 → UI pending 态（意图）
  → 下一个被接受的 step 前，内核向日志追加 log-only 事件 'cherry/work-mode' { active: boolean }
  → agent/pre-step 折叠当前模式：
      active → 注册工具 schema + 注入工作模式提示词段落
      off    → tools.restrict 空集 + 无注入
  → 事件回流 → UI 投影为已生效态
重启/resume：foldWorkMode(events) last-wins 折叠恢复
```

- 事件名 `'cherry/work-mode'`，通过 declaration merge 加入 `SessionEventMap`（与 dsh-session-title 的做法一致）
- 模型幻觉调用已关闭工具 → `UNKNOWN_TOOL` 错误兜底（dsh 内建）

## 6. 工具事件投影映射（kernelChat）

| dsh 事件 | → ToolMessageBlock |
|---|---|
| `tool/call`（callId/name/arguments 原始 JSON 串） | 新建块：toolId=callId、toolName=name、arguments=JSON.parse、status=STREAMING |
| `tool/result`（message.content/error?/meta?） | 更新同块：content、status=SUCCESS（有 error 则 ERROR）、meta 入 metadata（`rawMcpToolResponse` 类型需放宽为通用展示载荷） |
| approval 请求（ctx.approval 瀑布） | 新增 IPC 往返：内核挂起 → 卡片等待态（ToolBlockGroup.getBlockIsWaiting 现成）→ 用户点击 → IPC 回执 → 内核继续 |

## 7. 分期路线

### Phase 0：地基（schema）
- Assistant/AssistantSettings 删除死字段及引用
- Assistant 增加 `workModeDefault`/`accessiblePaths`/`approvalMode`（可选字段）
- KernelTopic（topics.json）同步三字段；旧话题缺字段默认折叠（off / [] / 'ask'）
- 验证：`pnpm build:check` 通过；旧话题正常打开、历史渲染正常

### Phase 1：点亮工具卡片（投影 + approval 往返）
- kernelChat 投影 tool/call、tool/result（含历史还原 projectEventsToMessages）
- approval IPC 往返：preload `dshApproval*` + IpcChannel + 内核 approval 服务挂接 + 卡片等待态
- 挂 `dsh-tool-ask-user` 做端到端验证（无害工具）
- 验证：对话中触发 ask_user → 卡片出现 → 点击应答 → 结果正确渲染；重启后历史工具卡片完整

### Phase 2：工作模式开关
- 'cherry/work-mode' 事件 + fold + pre-step 注入 + tools.restrict 执行端
- InputbarTools 增加右侧插槽区；工作模式 Switch（pending/已生效两态）
- 助手设置"工作模式"一节 UI（三项）
- 验证：流中可拨、下一轮生效；重启后话题模式自恢复；新话题继承助手默认

### Phase 3：真工具落地（fs + 工作区 + 审批）
- 引入 `@deepseek-ai/dsh-tool-fs`、`dsh-fs-local`（+ `dsh-fs-observation-policy`）
- 工作区生效（accessiblePaths → workspaceRoot）；SessionWorkspaceMeta + 外开编辑器按钮
- 审批三档生效
- 验证：工作模式下模型可读写工作区文件并出卡片；三档行为符合 §4.2；模式关闭后工具调用被 UNKNOWN_TOOL 拒绝

### Phase 4：完备（bash/pwsh + 沙箱 + 命令）
- `dsh-tool-bash`/`dsh-tool-pwsh` + local/sandbox 后端 + 沙箱三件套（含 windows-acl）
- `dsh-commands` 斜杠命令接入 inputbar 面板
- 可选：`dsh-plan-mode`、`dsh-user-questions`
- 验证：命令行工具在 workspace-auto 下 confined 执行；沙箱不可用时 SANDBOX_UNAVAILABLE 正确反馈

## 8. 开放问题

- `plan_model`/`small_model`（v1 双模型编排）：缓议，待有真实需求
- `maxToolCalls` 重映射：dsh 是回合/步数与超时语义，与调用预算不等价；删除后如需要另立
- 专属工具卡片：通用卡片先行；只有 v1 已有专属渲染的（fs diff 等）才做专属
- 快速助手路径：永远纯对话，工作模式体系不溢出
