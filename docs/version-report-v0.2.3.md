# Re_Cherry 版本报告 —— v0.2.3

> 日期：2026-09-09
> 区间：v0.2.2（66bf375）→ v0.2.3（tag）
> 前置：v0.2.2.1 阶段整段已压缩为单一基线提交 bda51ea；"删除实装前"检查点 3ab5b37（并行回答 + 快捷助手对账）。
> 验证：tsgo node/web 双门禁 EXIT=0（2026-09-09）；用户真机初验通过。完整回归清单见 §7。

---

## 1. 版本定位

v0.2.2.1 完成了会话树统一数据源与内核权威化，但消息级删除因 bug 密集被整体拆除暂缓，"删除实装前"基线定于 bda51ea。本版本以全新单入口引擎 **destroyTurns** 把删除系统装回 —— 内核一次事务算完受影响集合 / 物理截断 / 焦点，渲染层只消费结果。同时交付本阶段积累的全部工作：页码系统、并行回答改造、快捷助手 split-brain 修复、硅基流动思考修复。

## 2. 交付内容

### 2.1 页码（重发页签）系统 —— conversationModel 结构投影

- 复用分叉图合并树，不做第二套分组：`conversationModel.ts` 现为纯函数对话树（parseSessionEvents → buildPageFamily 复刻 BranchGraph 合并规则）。
- 语义定稿：答案页 = 同一提问节点下全部回复（创建序编号）；提问页 = 紧随同一回复节点的多个提问；只标"当前会话自有区"的组员卡，父卡/祖先共享区/被合并副本一律不标。
- 切页 = materializeKernelTopicRow + requestTopicSwitch；不做同屏并列、不在分叉图上标页码。

### 2.2 硅基流动思考修复 —— 通用"端点 → 思考协议"登记表

- 病灶：pi-ai 不识别 siliconflow，通用 OpenAI 路径只发 reasoning_effort；硅基流动 DeepSeek 混合思考认 enable_thinking → 思考从未开启。
- 机制：kernel providers.ts 的 KernelModelInput 增加可选 compat 原样透传；renderer 新增 `reasoningCompat.ts` 登记表（apiHost/provider 命中网关 + appliesTo 限定模型家族 → compat）。
- 新网关 = 表加一行。已登记：硅基流动（qwen 格式、supportsReasoningEffort:false、requiresReasoningContent）。

### 2.3 并行回答（v1 遗产"切换模型回答"的 parallel 改造）

- 病灶：v1 在同一话题追加补答，污染主上下文（并行回答污染病灶本体）。
- 设计：补答走 `ctx.agents.create` 隐藏 parallel 子会话（seed = 锚问所在轮），卡组只在本页投影渲染；主会话零污染。内核按 seed_length 血统边界自动回收牵连（见 2.5 引擎）。
- 已知简化（本轮明示不做）：@model 提及路径不迁移；旁答不能再并行（foreign-topic 卡直接跳过）。

### 2.4 快捷助手 Ctrl+Space 失控（split-brain 对账修复）

- 病灶：redux-persist rehydrate 与主进程 config/ShortcutService 两套真相源互相覆盖 → 开关全关后仍呼出。
- 机制：幂等启动对账（不是修迁移——已分裂环境必须每次启动推平自愈）。renderer → main 单向，主进程零改动。
- 落点：hooks/useBootConfigSync.ts（rehydrate 后一次性 config.set ×2 + shortcuts.update）；App.tsx PersistGate 内挂载（仅主窗口）。

### 2.5 消息级删除（本版本核心）—— destroyTurns 引擎（src/main/kernel/topics.ts）

内核单一权威入口 `topicTree.destroyTurns(topicId, anchorUserSeqs)`：一次事务内算完受影响集合、物理变更、焦点。渲染层不再自算任何集合。语义（与 v0.2.2.1 §2.7 定稿一致）：

- **锚** = 轮问题 seq。渲染层归一：user 取自身；assistant 归一到其 askId 问题 —— 并行卡组天然落旁答子会话，引擎按血统上溯。
- **Owner** = 血统（target→root）上第一个 `seed_length ≤ 锚 seq` 的会话；cutoff = 锚轮 `turn/start` seq（必须 > ownerSeed）。
- **keepsOwnTurn**：owner 在 (ownerSeed, cutoff) 内有自有 user → 前缀截断（Option A：同 id 保留，物理 `DELETE events WHERE seq ≥ cutoff`）；无自有轮后续 → 连锚轮整删；自有区为空 → empty-shell（保 id 删全量，本页可继续）。
- **后代**：`seed_length ≥ cutoff` 的子树整支清盘（物理 DELETE + 注册表移除）；更早 fork 的子分支原样保留。
- **焦点** = 血统邻接：同级同 seed_length 按 createdAt 序取后者（无后取前），无同级回父页。渲染层只消费 focusTopicId。
- **拒绝整单**：任一会话 running、锚不在实时日志（视图过期须刷新）、跨分支多锚。
- **sqlite 加固**：BEGIN IMMEDIATE + busy_timeout=5000 + 截断后 wal_checkpoint(TRUNCATE) + VACUUM；外部变更 revision+1（prepared 缓存失效契约）。
- IPC 链：IpcChannel.Dsh_TopicDestroyTurns → kernel/index.ts → services.ts → preload dshTopicDestroyTurns。

### 2.6 删除接线（渲染层）

- services/kernelChat.ts：destroyTurnsInKernel 包装 + DestroyTurnsResponse 同构类型；复用 kernelAnchorOf 血统判定。
- hooks/useMessageOperations.ts：
  - `deleteMessagesByIds`：单次单会话调用（跨会话多选拒绝 → 返回 false → UI 报错，修复 v0.2.2.1 记录的"toast 成功但未删"假反馈）；
  - `applyDestroyTurnsResult`：purged → clearTopicMessages 收本地 + removeTopic（级联清子行）；truncated → dshTopicOpen 重开 + 整表重投影 + updateTopicUpdatedAt（驱动 familyRefreshKey / 分支图 / 并行卡组全家族刷新）；本页被清盘 → materializeKernelTopicRow + requestTopicSwitch（旁答隐藏会话回父页，不整页跳）。

### 2.7 清空话题语义归一 + 'clear' 假标记整链拆除

- 清空话题从"只清 Redux、换页即复活"改为 destroyTurns(首个可解析轮) —— 物理真删。空页/未回执页无锚时拒绝并告警。
- 物理截断即上下文切，不再注入任何标记。整链拆除：Messages.tsx NEW_CONTEXT 注入监听、Message.tsx clear 渲染分支 / NewContextMessage / Divider、EventService NEW_CONTEXT 键、createNewContext、Inputbar onNewContext 全链（回调 / Provider 三处类型与转发 / TokenCount onClick）、tools/newContextTool.tsx 与 NewContextButton.tsx 两文件及注册。多选删除改单次批量调用。

## 3. 已移除 / 不再恢复

- Dsh_TopicTruncate 旧通道（v1 截断，791ff74 随历史清理不可恢复）—— 由 destroyTurns 取代，不回装。
- getUserMessage type 'clear' 注入路径、多选 Promise.all 假批量。
- clearTopicMessagesThunk 调用方已移除（导出留存，v2 随 thunk 层清理）。
- 保留为静态无害（无监听者）：toggle_new_context 快捷键定义与 i18n 键 —— 随后续快捷键面板清理。

## 4. 质量与验证

- tsgo --noEmit -p tsconfig.node.json / tsconfig.web.json 双 EXIT=0（2026-09-09）。
- 沙箱限制：vitest / biome / Electron 未在本环境执行；等效性由 §7 清单覆盖。
- 用户真机初验通过（删除实装反馈："做到了"）；完整回归以 §7 为准。

## 5. 已知问题 / 风险

- destroyTurns 引擎无自动化测试（沙箱禁跑 vitest）；§7 清单覆盖回归。
- supersededByTopicId：Option A 下无新写入，仅剩 4 处读取过滤（listTopics / sweep）；v2 清理。
- 跨分支多选仍拒绝（内核报 anchors span multiple sessions，UI toast 失败）—— 预期行为。
- '@renderer/store/assistants' 侧 removeTopic 为级联删除（血缘根消失一并清子行）—— 与引擎 purged 集合一致性依赖内核为唯一权威，渲染层不并发删除。

## 6. 后续计划

- Work Mode（Phase 0–2）—— 见 docs/improvement-checklist.md §1.1。
- v2：supersededByTopicId 清理；clearTopicMessagesThunk 死导出清理；toggle_new_context 残留清理。
- 引擎级 vitest（获得可跑环境后补）。

## 7. 真机验收清单（存档）

1. 单删普通轮 → 该轮起物理截断，刷新/重开 App 仍在；
2. 删最末轮 → 回退上轮（keepsOwnTurn=false 双删语义）；
3. 删中间分叉轮 → 该分支整支消失、分支图/家族签名刷新；更早 fork 的兄弟分支保留；
4. 并行回答行删锚点问题轮 → 旁答卡组全部消失（子会话 purged）、焦点回父页；
5. "清空话题"按钮/快捷键 → 本页全轮物理删除（根页：空壳可继续；fork 页：清盘 + 焦点跳转）；
6. 同页多选删除 → 单次事务全删；跨分支选择 → 失败 toast（预期）；
7. 运行中会话点删 → 整单拒绝（预期）；
8. 删除后核对：sessions.db 行数与 topics.json 一致、revision+1、事件 seq 符合截断断口。

## 附录 A：区间提交清单（v0.2.2 → v0.2.3）

- 66bf375 chore: release v0.2.2（区间起点 / origin 基线）
- bda51ea chore: single local baseline —— v0.2.2.1 development + resend page indicator + SiliconFlow thinking fix
- 3ab5b37 checkpoint（并行回答 + 快捷助手对账，用户本地检查点）
- 本次发布提交：v0.2.3（删除系统实装 + 本报告）

## 附录 B：净变更（diff 66bf375 → v0.2.3 工作树）

57 files changed, 3891 insertions(+), 561 deletions(-)

主要落点：src/main/kernel/topics.ts（destroyTurns 引擎）、services.ts、index.ts、packages/shared/IpcChannel.ts、src/preload/index.ts（IPC 链）；renderer：hooks/useMessageOperations.ts、useChatContext.ts、services/kernelChat.ts（接线）；Inputbar / Messages / EventService（'clear' 链拆除）；conversationModel.ts（页码）；reasoningCompat.ts（思考登记表）；useBootConfigSync.ts（对账）。
