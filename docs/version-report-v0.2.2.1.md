# Re_Cherry 阶段性版本报告 —— v0.2.2.1

> 报告日期：2026-09-07
> 代码基线：`6dbe8c8`（工作树干净，仅余未跟踪的 `.pnpm-store/`、`docs/`、`agent-assistant-fields-report.md`）
> 覆盖区间：`v0.2.2..HEAD`（11 个提交，2026-09-06 全部完成）
> 构建验证：`tsgo` node + web 双端 `--noEmit` 通过（沙箱无法运行 Electron，真机行为需用户实跑确认）
> 版本说明：v0.2.2.1 为本阶段开发版本标签；`package.json` 仍为 0.2.2，正式发布号以 release 时为准

---

## 1. 版本定位与本阶段目标

v0.2.2（tag 指向 66bf375）之后进入"统一化架构"攻坚期。目标不是加新页面，而是把**会话结构的事实源收敛到内核单点**，为后续"工作模式 / 插件化"铺路：

1. 内核（DSH）成为话题血缘 / 分支 / 删除 / 思考档位的**唯一结构权威**，渲染层只做投影与指针切换，不自行解释结构。
2. 分支图（分叉图）成为**唯一分支控件**：侧栏只列根话题，fork 出来的分支只从分叉图进出。
3. 删除语义彻底去 UI 假删：要么不删（按钮保留为 no-op），要么由内核算出受影响集合与焦点后物理清盘。
4. 为将来插件接管预留服务 seam（`ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning`）。

## 2. 本阶段交付内容

### 2.1 统一会话树数据源（02d2f0c / 6dbe8c8）

- 新增 `useConversationTree(rootTopicId, refreshSignature)`：以根话题为单位、以"签名"驱动重取的唯一树数据源。
- 新增 `conversationTreeCache.ts`：根话题 → `{signature, promise}` 的共享家族缓存，`loadConversationTree` / `invalidateConversationTree`；**每个根只拉一次，所有视图共享**，禁止各组件自拉。
- `BranchGraph.tsx` 改为消费该 hook（删掉了自己的 useEffect 拉取），家族数据经 `parseSessionEvents` 建模。

### 2.2 会话模型层（conversationModel.ts）

- `parseSessionEvents`：**种子边界规则**——边界 = 最大 user seq 之下最后一个 `session/end-seed`（剔除拖尾 end-seed）；无则回退最大 end-seed。
- `CMFamily`（rootId / sessions / byId）、`loadFamily`（要求根在前、父先于子）、`originOf`、`validateFamily`、`pathOf`、`contentText`。
- 页码（projection）机制已按用户要求整体移除，**没有第二套加载/刷新/渲染逻辑**。

### 2.3 内核服务 seam 与权威化（dc87b81 / e3f85ea 内）

- `kernel/services.ts`：`TopicTreeService`（listRoots/listBranches/get/create/rename/updateConfig/open/delete/fork/send/stop/isRunning/events）、`SessionGCService.purge`、`ReasoningService`（supportedLevels/resolveRequest）；`registerAppServiceSeams(ctx)` 幂等挂到 ctx（重复挂只告警覆盖）。
- `kernel/index.ts`：boot 时 `registerAppServiceSeams(ctx)`；IPC 一律经 `topicTree(ctx)` / `reasoning(ctx)` 访问器薄转发，未注册即抛错。
- 实现取舍：根 ctx 手动属性挂接可用（cordis 插件化 Service 方案 e16018b 曾实现但按用户选择回滚，属"魔改版内核"收敛点，未正式插件化）。

### 2.4 消息 id 规范化 + 停止按钮修复（e3f85ea）

- 发送时本地 uuid 收到内核回执后改写为 `kernel-<topic>-<seq>`：`newMessage.ts` 新增 `replaceMessageId`（移动实体、替换有序 id 列表、同步更新同话题 askId 引用）。
- `abortController.ts` 新增 `renameAbortController(from, to)`：中止注册键随 id 改写迁移，**停止按钮不再因 key 脱钩而失效**。

### 2.5 种子边界修复（d25417f，重要）

- 持久化日志带拖尾 end-seed，旧规则会把它算进种子区，导致**重启后每个 fork 的自有轮被清零、分支塌缩成一条主线**。
- 修复：种子边界 = 最后一条"低于最大 user seq"的 end-seed（kernel 侧 `seedBoundarySeq`，渲染侧 `parseSessionEvents` 同步规则）；重启后分支结构与重启前一致。

### 2.6 整话题删除 = 物理真删（6ac0bbd 加固）

- 链路：渲染层删行（assistants store 的 `removeTopic` 级联删子分支行）→ 整话题内核 `deleteTopic` → `deleteTopicRecursive`（先递归子话题、dispose agent handle、注册表移除、persist）→ `ctx.sessionGC.purge` → `purgePersistedSession`（node:sqlite `DELETE events/sessions WHERE session_id=?` + `wal_checkpoint(TRUNCATE)` + 尽力 `VACUUM`）。
- 字节级验证过：删后注册表 / sqlite / 全文检索均无残留；freelist 字节残留在一次重启后由真空回收（946KB→94KB）。
- 已知风险：早期 sqlite 写锁下 DELETE 可能静默失败导致复活；6ac0bbd 以 checkpoint+vacuum 缓解，**若复活再现需补 busy_timeout/重试/删后校验**。

### 2.7 消息级删除：已整套拆除、暂不装回（791ff74 + 用户"先回滚"指令）

- 渲染层 `useMessageOperations.deleteMessage / deleteGroupMessages` 保留为 **no-op（logger.warn）**，带 `[恢复标记]` 注释，**不做任何 UI 假删**。
- 内核侧曾实现并提交"deleteTurnAt 全链路"（7a26cee：resolveTurnOwnerSession → 前缀后继截断 → 血缘含该轮的后代整删 → 不含该轮的后代重挂最近存活祖先/后继 → focus 由内核计算）；随后按用户指令 `git reset --hard 6dbe8c8` 回滚，**当前基线不含该实现**（提交仍存于 reflog HEAD@{1}，可随时恢复）。
- 语义规则（已确认，未装回）：删同父多分支之一 → 只删该子树、焦点同级左移/右补；仅"问+答"则连问带答删除并回退一层；删提问轮 → 连整棵后代删除；焦点一律由内核按树/血缘邻接计算，不做 createdAt 随机跳。

### 2.8 思考档位统一（f341a52 / providers / reasoning）

- 六档常驻：`none / auto / low / medium / high / max`（`REASONING_UI_OPTIONS`），`auto→low`、历史 `default→low`；非思考模型返回空列表、UI 隐藏入口。
- 内核档位词表 `KERNEL_REASONING_LEVELS = off..max`；`providers.ts` 的 `KernelModelInput.reasoningEfforts` 声明被卫生化（只留合法档位 + 合法 wire 值、至少一个非 off 档位，否则不声明），配 `clearModelCapabilityCache`。
- 全链路透传：`assistantReasoningLevel(assistant)` → `sendToKernel(..., reasoningEffort)` → IPC `Dsh_TopicSend / Dsh_Complete` 带 `reasoningEffort` → 内核 `reasoning(ctx).resolveRequest` 收敛。
- mini 窗同步支持：thinking 块懒建/流式合入/结束置 SUCCESS（HomeWindow.tsx），并读取 `quickAssistantReasoningEffort`。

### 2.9 分支创建与切换（f341a52 / dc87b81 之后）

- 分叉图：每轮 user 消息一节点 + 其回复（assistant 链）；沿 `originOf` 判定共享前缀；高亮当前 active path；点节点 → `onOpenBranch(sessionId)`。
- 侧栏（Topics.tsx / useTopic.ts / HomePage.tsx）：只列根话题（`listRootTopics`）；默认话题 = 根话题 `[0]`；分支话题只经分叉图打开。
- `topicBranch.ts`：`kernelRootTopicId / materializeKernelTopicRow / requestTopicSwitch / loadKernelTopicRootIds / invalidateKernelTopicRootIds / shouldShowTopicRow`；`TOPIC_SWITCH_REQUEST` 自定义事件让深层组件也能请求切话题。

### 2.10 其他清理

- 删除话题在 assistants store 层的行为对齐血缘（`removeTopic` 级联、`updateTopics` 保留仍存活根下的 fork 子行，避免侧栏更新误删分支）。
- 推理空档保护（111a8f9 内 reasoning empty guards）。

## 3. 已移除 / 明确不做

| 项 | 说明 |
|---|---|
| 页码功能 | 按用户要求整体移除（多次实现被否后决定移除；git 回退到 6dbe8c8 之后不再有 page 代码） |
| 消息级删除全链路 | 7a26cee 已实现又按指令回滚；基线保持 no-op 按钮 + 恢复标记，待用户决定装回 |
| UI 假删 / 单渲层自行判结构 | 全面禁止：删除必须是内核算集合 + 物理清盘 |
| 插件化 Service | 暂缓：保留根 ctx 手动 seam（`registerAppServiceSeams`），不做 cordis 正式插件 |

## 4. 质量与验证状态

- `tsgo --noEmit` node + web 双端通过；每个 checkpoint 提交前均自检。
- 沙箱无法启动 Electron：**分叉图交互、删除规则、重启不塌缩、物理无残留等均需用户真机构建后实跑验收**。
- 建议验收清单（真机）：
  1. 分叉图在开/关/重启后与删除前一致，不塌缩成主线；
  2. 整话题删除 → 重启 → 全局检索（注册表/sqlite/字节）无该内容；
  3. （若装回消息删除）按第 2.7 节语义逐条验证；
  4. 停止按钮在任意轮可停；思考档位切换与透传正确。

## 5. 已知问题 / 风险

- 消息删除目前只是 no-op：按钮在，点了只告警，用户可感知"删不掉"（属有意为之的过渡态，需尽快定夺装回）。
- sqlite purge 无 busy_timeout/重试；高并发写场景复活风险仍在（6ac0bbd 只是缓解）。
- 根 ctx 手动 seam 属非标准 cordis 用法（child ctx 属性挂接会崩，"cannot get property without inject"），插件化正式化仍需插件 Service 方案。
- 页码功能需求如后续再提，只能以"树投影"形态重做，不得另起第二套机制。

## 6. 后续计划（建议）

1. 用户真机验收基线（第 4 节清单）；
2. 按用户决策把消息级删除装回（恢复 7a26cee 或按新规则重实现），装回后立即真机验证第 2.7 节语义；
3. 若复活再现：给 purgePersistedSession 补 busy_timeout + 重试 + 删后 rows 校验；
4. 工作模式 / 工具卡片：基于本阶段统一数据源与内核权威继续（见 docs/work-mode-evolution.md、improvement-checklist.md），不动 Redux 消息管线结构。

## 附录 A：区间提交清单（v0.2.2..HEAD，新→旧）

| commit | 内容 |
|---|---|
| 6dbe8c8 | 单一共享家族缓存 conversationTreeCache（每根一拉、全视图共享） |
| 02d2f0c | 单一会话树数据源 useConversationTree；BranchGraph 消费统一 |
| 6ac0bbd | purge 加 checkpoint+尽力 vacuum（无字节残留） |
| 791ff74 | 拆除消息级删除机制（按钮 no-op+恢复标记）；保留整话题物理删除 |
| f45e2c7 | ghost 检查改为自有轮直计；删页 model 遗留导出与旧注释 |
| 95654e2 | 删除焦点锚定到被答问题（同问多岔→其 origin owner→回退），不再按 createdAt 乱跳 |
| d25417f | 种子边界=最大 user seq 之下最后 end-seed（重启分支不塌缩） |
| e3f85ea | 内核锚点阈值子树删除雏形；停止按钮 abort-key 随 id 改写迁移 |
| dc87b81 | 统一会话/树权威（内核根、内核 id、服务 seam）——插件拆分前检查点 |
| 111a8f9 | 删除走内核 cascade+purge+sweep、去全部 UI 假删、分叉图实时刷新、推理空档保护 |
| f341a52 | 推理档位统一（六档常驻 auto=low）、分叉图与侧栏清理、fork 血缘加固（wip） |

## 附录 B：v0.2.2 之后净变更（diff v0.2.2..HEAD）

38 文件，+2458 / −403。主要：BranchGraph.tsx(+563)、kernel/topics.ts(+428)、conversationModel.ts(+190)、useMessageOperations.ts(±)、BranchGraphButton.tsx(+160)、topicBranch.ts(+132)、kernelChat.ts(+133)、kernel/services.ts(+119)、kernel/index.ts、providers.ts、store/assistants.ts、store/newMessage.ts、utils/abortController.ts、utils/reasoningKernel.ts、shared/config/reasoning.ts、mini HomeWindow.tsx、QuickAssistantSettings.tsx、Inputbar/ThinkingButton.tsx、Topics/TopicManageMode/TopicContent、useConversationTree/conversationTreeCache。
