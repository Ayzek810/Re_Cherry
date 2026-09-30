# v0.4.7 头脑风暴 —— 需求冻结前的实用功能模块候选清单

> 状态：调研进行中，候选来源已按用户裁定纠正（2026-09-30 第二轮）。
> **用户裁定（纠正版）**：**cherry-studio v1.9.11 与 v2 是关键上游，候选主要从他俩挖**；参考资产其余项目仅辅助印证。内核官方件不默认进清单——须对照项目本体评估必要性。内部缺口里最高优先：**全局记忆从未完全接线**（本轮已实锤，见 E7）。
> 版本定位：v1 全量审查前的最后一个加功能窗口，本清单即「冻结前最后盘点」。

## 0. 方法与范围

- 调研源五路：① 内核包能力盘点（声明未 import 的 dsh-* 包）② CS V2 源码对比 ③ 参考应用（chatbox / deepwrite / Academic-Agents-Studio / Paper-Agent）④ 业界同类产品（Open WebUI / ChatWise / Msty / LobeChat 等）⑤ 项目内部已知缺口（CLAUDE.md 已知限制 + 路线图遗留）。
- 评估维度：主目标契合度（agent+chatbot 统一、DSH 内核单路径信任模型）× 用户价值（个人桌面单用户）× 实装成本（S/M/L）× 架构风险（是否违硬性不变量）。
- 信任模型参照：三档工作模式 = dsh 权限预设（`packages/shared/config/workMode.ts`：read-only / workspace-write / danger-full-access）；会话外留痕的能力归外置/工作模式面。

## 1. 现状基线（已确认存在，候选中不重复提）

- 页面：首页聊天（DSH 内核单路径）、翻译、绘画、知识库（RAG，O(n) 余弦）、笔记、文件、小程序 minapps、Code Mate、历史、设置、Launchpad。
- 工具：ask_user_question、ocr_document、web_search、knowledge_search、skill、read_document、describe_images、generate_image、web_fetch、knowledge_read（内置/条件挂载）；fs、fsSearch、editor、pwsh、jobs、trash、saveAttachment、memory、todo、goal（外置/工作模式）。
- 消息面：编辑重发、重新生成、**switchModelAnswer 并行 fork 换模型重答**（`hooks/useMessageOperations.ts`）、消息/话题导出（markdown/Word/Yuque/Siyuan/Notion）、引文脚注、mermaid/plantuml/graphviz/svg 预览、思考计时、任务面板（todo/goal 事件折入）。
- 其他：快捷助手迷你窗（独立轻通路）、文档解析（LocalPaddle OCR + 视觉模型，GPU 加速）、备份恢复、API key 加密存储、MCP、技能系统、Paper-Agent / hermes / dsh / 受管 CLI 工具家族、Code Mate 插件市场、检查更新。

## 2. 候选清单

### A. 内核未接线能力（dsh 包盘点，源码证据：参考资产/deepseek-harness/packages/）

> **第二轮用户质疑后的必要性重评**：下列均为"内核里存在且未接线"的事实盘点，但**存在 ≠ 本项目需要**。对照项目本体（个人单用户、已有工作模式/toolEscalation/话题级档位/手搓截断）逐项判定见 §3 矩阵——结论：**全部撤出 Tier 1**，仅 spill/retention 保留为 S 级顺手项候选，其余按需或不动。本节保留作能力地图，防止将来重复调研。

> 结论先行：已声明未 import 的 20 包中 13 个是纯传递依赖；**连依赖都没声明的盲区里藏着官方 dsh-base 必挂的 compaction/subagent/workflow/plan-mode/schedule 大件**。

**A 组-1：已声明未挂载（5 个真空缺）**

| # | 候选 | 能力 | 接线方式 | 成本 | 判断 |
|---|------|------|----------|------|------|
| A1 | dsh-commands 斜杠命令 | 插件注册 /命令（可带图），UI 执行，只写 command/run+done 日志、**零模型 token**；官方 /permission /compact 免费跟进 | ctx.plugin 挂载 + 渲染层 "/" 发现菜单（interaction hub 同款 IPC）+ 注册首批命令 | M | 值得：对话 UX 主菜 |
| A2 | dsh-code-runtime run_code | 模型在 worker 线程跑 TS/JS，工具以 async 绑定注入，返回 value+logs；补 pwsh 外的 JS 计算空缺（xlsx/JSON 加工） | 新插件挂 dsh-code-runtime-worker-thread，经 dsh-tools 开 run_code；worker 非安全边界，只配工作模式 | M | 值得试 |
| A3 | dsh-permission-presets + session-projection | 权限档写日志钉进会话（重启不丢）+ 日志→整值投影注册表（todo/goal/权限 snapshot 取走） | 新插件 + 渲染层改读投影；把 work-mode 三档迁到内核日志 = 路线图"一键切换"的内核形态 | M | 值得评估（中期三件套与 A1 一起接） |
| A4 | dsh-output-retention + spill-local/policy | 有界保留库（标准化截断通告）+ 超大工具文本落盘+预览+取回；webFetchTool.ts:10 注释点名的空缺 | 库直用替换 fork 工具手搓截断 + ctx.plugin 挂 spill-local/policy | S-M | 值得：S 级顺手 |
| A5 | guard 两件：repeat-tool-reminder / tool-call-timeout-policy | 防循环提醒 / 工具调用超时 | guard 组挂载 | S | 值得 |

**A 组-2：连依赖都没声明的真盲区（官方 dsh-base 必挂项）**

| # | 候选 | 能力 | 成本 | 判断 |
|---|------|------|------|------|
| A6 | **compaction 套件**（compaction(-basic) + token-meter + command-compact + tool-result-pruner） | token 计量驱动、LLM 摘要旧回合、/compact 命令、回放安全的工具结果修剪——fork 会话现无界增长 | M | **长会话刚需，候选最前段** |
| A7 | **dsh-schedule** | 会话级持久 after/at/fixed-rate 提醒 = v0.4.6 deferred cron 的**原生实现**（与 B8 互为印证） | M | 值得 |
| A8 | subagent 套件（subagent + spawn/fork 后端 + tool-subagent/-control/-report） | 子代理委派三件套；claude-agent-sdk 后端最省事（devDeps 已有） | L | 视需求 |
| A9 | workflow + tool-workflow + tool-ralph | JS 编排脚本多代理 / fresh-agent Ralph 循环 | L | 视需求 |
| A10 | dsh-plan-mode | 计划模式：日志态 + /plan 命令 + 用户审阅退出 | M | 与 DSH 工具观契合，值得 |
| A11 | session-query(-sqlite) + tool-session-query | 模型面 FTS5 日志搜索/trace（与 B5 全局搜索互补：一个是模型工具一个是 UI） | M | 可选 |
| A12 | dsh-agent-instructions | 工作区 AGENTS.md/CLAUDE.md 装载进上下文 | S | 可选 |
| A13 | 中价值按需组：time-context（每步注入当前时间）、file-reference/session-reference（@file/@session）、terminal+persistent PTY、LSP 套件、storage(+json/sqlite)+workspace、persona/agent-presets、message-feedback、session-stats、session-log-export、code-runtime-python | 各一句话能力 | S-M/个 | 按需 |

**冗余勿接**（官方有但 fork 已有自研等价物）：dsh-tool-web/web/web-fetch-http/web-search-*（自研 webFetch/webSearch）、dsh-skill/*（自研技能）、dsh-mcp-client（自研 MCPService）、dsh-session-title（有意渲染层 topicNaming）、bash 系（Windows 不需要）。
**不适用**：client-*/host-*/api-*/sdk-*/acp/bundle/boot（Web 远程面）、e2b、agent-team、tool-cordis（模型自装插件）、typert 构建期、telemetry。

**A 组-3：dsh-authorization**：OAuth 式"和人对话拿凭证"流——**不是**官方提权流（提权编舞 fork 已在用 dsh-sandbox+ctx.approval）；只有要接 OAuth 提供商（Codex/Claude 登录）才需要 → 与 E4 MCP-OAuth 合并评估，暂缓。

### B. CS V2 未移植功能（源码核实，参考资产/cherry-studio v2）

**很值得：**

| # | 候选 | V2 实现证据 | 说明 | 适配 | 成本 |
|---|------|------------|------|------|------|
| B1 | **用量统计面板** | settings/UsageSettings/ + main/data/db/schemas/aiUsageRecord.ts | 每请求 token/费用/缓存命中落 SQLite；热力图（连续天数）、趋势、模型/服务商分布、明细表 | 内核事件（计量入库，渲染层纯展示）；消息级 usage 已有，缺聚合 | M |
| B2 | **上下文自动压缩 compaction** | main/ai/streamManager/context/PersistentChatContextProvider.ts | 超预算自动把旧历史摘要折叠为压缩锚点；附件/工具输出保留清单；/compact 命令 | 内核上下文构建处折叠，渲染层只消费 anchor 事件 | L |
| B3 | **上下文占用指示** | components/chat/contextUsage/ContextUsageMeter.tsx | 当前对话占上下文窗口百分比（变色）+ 输入框本条 token 数 | 内核事件；与 B2 配套 | S |
| B4 | **模型健康检查** | ProviderSettings/utils/healthCheck.ts | 逐模型真实测试请求，多 key 轮询验证，通过/失败/跳过原因 | 独立通路（直连 provider 探测）；配错 key 不用聊天撞墙 | M |
| B5 | **全局搜索面板** | components/GlobalSearch/GlobalSearchPanel.tsx + schemas/search | Cmd+K 浮层：跨话题/会话/助手/知识库/消息正文，最近访问、分组预览、点击定位 | 渲染层投影（全文索引 + 覆盖层）；历史页只能按标题翻 | M |
| B6 | ~~**消息级分支 + 分支图**~~ **用户裁决不做（2026-09-30）：fork 现有机制实现更好** | TopicBranchPanel.tsx、TopicMessageFlowCanvas.tsx | 话题内消息是树：重生成/编辑产生兄弟分支可切换 + 可视化流向图；agent 会话整段 fork | 内核会话层消息树，渲染层画图投影；Re_Cherry 分支在会话级 | M |
| B7 | **系统截图工具** | windows/screenshot/ + main/services/screenshot | 全局快捷键截屏：框选/标注/马赛克，框完直接 OCR 喂模型 | 独立通路；与已有 OCR 栈复用 | M |
| B8 | **定时任务** | TasksSettings.tsx + SchedulerService.ts + JobScheduleService.ts | 提示词/agent 定时或周期执行，运行历史管理 | 主进程调度器到点发起内核请求；= v0.4.6 defer 的 cron | M |

**可选：**

| # | 候选 | 说明 | 成本 |
|---|------|------|------|
| B9 | 提示词库（搜索/排序/绑定助手 + 预设库） | 技能系统之外的轻量补充 | S |
| B10 | IM 渠道接入（Telegram/飞书/QQ/微信/Discord/Slack bot） | 手机远程用 agent；运维成本高 | L |
| B11 | API 网关 + 设备配对 + LAN 互传 | 本机开 OpenAI 兼容网关复用 key，手机扫码远程用 | L |
| B12 | 笔记/网盘导出同步（Notion/Obsidian/Yuque/Joplin/Siyuan/WebDAV/S3） | 备份已有；这是"存到我所在的地方"（部分已有：Word/Yuque/Siyuan/Notion 导出已在） | M/目标 |
| B13 | Doctor 体检 + 诊断包 | 一键环境自检出报告；反馈打包日志 | S/M |
| B14 | 划词助手（系统级划词浮条 → 翻译/提问） | 快捷迷你窗的系统级入口 | S/M |
| B15 | 多模型同问并排对比 | @ 多模型一次同答 horizontal/grid/fold 布局；与 DSH 单路径相性一般 | L |
| B16 | 归档中心（话题按域归档恢复） | 渲染层投影 | S |
| B17 | 本地 Embedding 模型（内置下载本地向量化） | 知识库离线嵌入，隐私卖点 | M |
| B18 | 数据目录搬迁（userData 迁自定义盘） | 便携部署 | S |
| B19 | 升级后 Release Notes 页 | 锦上添花 | S |

**不建议：** OTLP 全链路追踪 UI（Re_Cherry 已有 trace 窗栈，开发者向）；codeMode 工具代码化调用（内核协议改造，相性未知，L）。

**反向发现**：该 V2 分支没有语音/TTS、没有快捷短语、没有长期记忆工具——Re_Cherry 的 memory 工具反而是 V2 缺的；知识库入库源 V2 仅 file/note/directory/url 四种。

### B+. V2 第二轮侦察（2026-09-30，i18n 差分 + composer/chat 深挖 + preference 键扫描；中间产物 `.recon2/i18n-diff-groups.txt`）

> 首轮误报修正：settings.data.trash 63 键实为归档中心（非回收站）；compaction 本体在 `packages/aiCore/src/core/context/`（vendored context-chef：durableCompaction/offloader/janitor），非插件体系。战略发现：**V2 已把 DSH 桥接为一种 Agent runtime（packages/dsh-bridge）**，与 fork 同源。

**大件：**

| # | 功能 | 证据 | 说明 | 成本 |
|---|------|------|------|------|
| V2-α1 | **追问队列 + Steering** | composer/QueuedFollowupsDock.tsx + chat.input.steer_shortcut | 生成中排队多条追问：插入当前轮(steer)/编辑/移除/暂停自动发送 | M |
| V2-α2 | **自动重试 + 备用模型降级链** | preference chat.retry.* | 失败按退避重试 N 次后切备用模型 | S-M |
| V2-α3 | 统一资源库 Library（助手+Agent+技能） | components/resourceCatalog/ + library.* | 分组/标签/搜索/导入（URL/剪贴板/文件）/导出 | M |
| V2-α4 | PDF 保留版式翻译（BabelDOC） | main/services/PdfTranslationService.ts | 双栏对照、流式进度、扫描件 OCR 预检 | L |
| V2-α5 | 依赖与本地模型管理页 | DependenciesSettings/ + binaryManager | mise/pipx 托管工具一键装；OVMS 本地模型（fork 的 Code Mate binaryManager 已覆盖一半） | M-L |
| V2-α6 | 代码块可编辑+可执行 | chat.code.editor.*/execution.* | CodeMirror 编辑态 + 受限执行 | M |
| V2-α7 | 对话历史记录管理页 | components/history/HistoryRecordsView | 跨助手话题表格：筛选/批量移动 | M |
| V2-α8 | 工具输出超限落盘（VFS offloader） | aiCore/core/context/offloader.ts | 超大工具结果落盘+占位+取回（与内核 spill 同题，V2 自研版） | M |
| V2-α9 | Copilot 官方接入（Device Code OAuth） | settings.provider.copilot.* | ——fork 有意裁撤 Copilot，勿接 | M |
| V2-α10 | Agent 运行时切换（DSH/Claude/Pi）+心跳 | dsh-bridge + runtime option | fork 单运行时，不适用；心跳可归入定时任务议题 | M |
| V2-α11 | Code 页多 CLI 后端 / minapp 细粒度权限 / 网页标注 | code.adv.* / miniApp.permission.* / WebviewAnnotationControls | 三件均为 M~L 重活 | M-L |

**S 级小件堆：** 引用笔记为输入附件+工具栏钉选、长文本粘贴转文件（阈值 500 字）、输入框随打随译、消息分区编辑、提示词绑定助手+AI 生成润色+系统变量（date/os/username/model_name）、知识库智能分段（沿 Markdown 结构切）+rerank/overlap 参数、xlsx 表格预览（工作表 Tab）、标签页弹独立子窗口、本地自动备份计划（间隔/份数）、导出 MD 细粒度选项（排除引文/带模型名/标准引文）、消息大纲锚点、多模型网格列数、**MCP 支持 DXT/MCPB 一键导入**（与 V1-4 DXT 互证）、quickPanel 作用域、更新测试通道 beta/rc、忙时阻止系统睡眠、翻译语种检测双引擎+翻译历史星标、拼写检查语言。

### B++. V2 截图功能专项侦察（用户点名，2026-09-30；完整移植评估存 `reports/cherry-v2-screenshot-porting-assessment.md`）

**V2 架构要点**：不用 desktopCapturer，用 `node-screenshots`（Rust napi）并发截全部显示器，**先截屏后开 overlay**（天然不拍到自身，无需隐藏主窗）；窗口枚举跑 worker_threads；每屏一个 frameless+transparent 置顶 overlay（pooled，opacity 0→首帧握手→reveal，崩溃/超时自愈）；工具 5 种（rect/arrow/brush/text/mosaic）纯 Canvas2D 自绘，undo/redo 即数组栈；**输出只进剪贴板**（save 走对话框落盘），不进 composer——fork 若做可决策"超出来源行为：截图直接进附件"；OCR = main 进 sharp 裁剪 → `@napi-rs/system-ocr` 优先 + Paddle 本地回退，OcrTextOverlay 是 PDF 式隐形可选中文字层（不可编辑）；IPC 走 V2 新 zod 体系（9 请求+3 事件），移植时降级到 fork V1 三层。

**移植评估（fork）**：总成本 **L**（砍 OCR 文字层+放大镜、多显示器只做主屏可降 **M**）。
- 直接可复用（近原样拷贝）：`src/renderer/windows/screenshot/**` 整目录、`main/services/screenshot/{screenCapture,nativeCaptureBackend,windowEnumerator,types}.ts`、useOcr/绘制 utils/reducer/constants。
- 需适配：ScreenshotOverlayService 去容器化（弃 pool 改每次新建可规避泄漏）、IPC 降级 V1 三层（IpcChannel+preload+ipc.ts）、OCR 接 fork 的 localPaddle、设置段、ShortcutService 加分支（该文件头有 v2 重构冻结标注，只加分支不动结构）。
- 需新写：WindowService 复刻 frameless/transparent 参数集（含 mac=panel / Linux 无 type 的平台分支）。
- **风险**：① 透明全屏窗跨平台参数（V2 注释已踩坑，照抄）；② Windows 混排 DPI 的非对称坐标换算必须原样搬否则选区错位；③ node-screenshots 打包 asarUnpack 漏配必炸（fork 已有 optionalDependencies+asarUnpack+after-pack 断言的家规，照办即可）。

> 排除 fork 有意裁撤项（agent 页/apiServer/更新器/Copilot/Pyodide/OVMS/划词助手/agents DB）。C 组核实为「其实已有」的负面发现同样有价值：快捷短语/快速面板/消息框选/话题搜索/备份矩阵(S3 并入 DataSettings)/MinApp/输入框@/快捷键 15 键——**均对齐，不用补**；消息级"新分支"按钮 fork 以话题级分支+BranchGraph+ResendPageBar 自有方案替代，不回移植。

**A 组——确实缺失：**

| # | 功能 | 上游证据 | 说明 | 成本 |
|---|------|----------|------|------|
| V1-1 | **消息级原地翻译**（译文块跟随消息） | home/Messages/MessageTranslate.tsx + Blocks/TranslationBlock.tsx | 长回复不切页对照翻译，读外文省力 | M |
| V1-2 | ~~**助手预设商店** + 新建助手弹窗~~ **用户裁决不做（2026-09-30）** | pages/store/assistants/presets/ + Popups/AddAssistantPopup.tsx | 一键获取精选助手预设；新建时搜模板而非空白格 | S-M |
| V1-3 | **Obsidian 集成**（读 Vault 进知识库 + 消息/话题导出到 vault） | main/services/ObsidianVaultService.ts + ObsidianExportPopup + ObsidianSettings | 聊天结论一键归档进 Obsidian；知识库直接吃 vault | M |
| V1-4 | **DXT MCP 扩展一键安装**（Claude Desktop 生态） | main/services/DxtService.ts | .dxt 拖进来即用，省手动 npx/sse 配置 | S-M |
| V1-5 | **系统电源事件守护**（关机/休眠前收尾） | main/services/PowerMonitorService.ts | Windows 关机/休眠时备份不半途而废、会话不丢 | S |
| V1-6 | LAN 局域网传输（设备发现+互传） | main/services/LocalTransferService.ts + lanTransfer/ | 换机/双机同步免网盘 | M-L |

**B 组——缩水回补：**

| # | 功能 | 上游形态 | fork 现状 | 成本 |
|---|------|----------|-----------|------|
| V1-7 | 翻译页偏好项（Markdown 输出/自动复制/自定义语言对） | settings/TranslateSettings/（Prompt+CustomLanguage） | fork 仅换模型；注释自述"V2 偏好项无对应数据层" | S-M |
| V1-8 | ~~图片 OCR + 多引擎~~ **用户裁决不做（2026-09-30）：现有实现更好** | main/services/ocr/ 四引擎 + useOcr | fork 仅 LocalPaddle 文档预处理；无独立图片 OCR 通道 | M |
| V1-9 | 文件页表格视图（尺寸/时间列） | files/ContentView.tsx | fork 仅网格/列表 | S |

### C. 周边参考程序调研存档（非上游主源，仅存档）

> 定位澄清（第二轮纠正）：本节是对参考资产中**周边接线参考程序**（gpt_academic/deepwrite/Paper-Agent）的一次性调研存档——**不是候选来源**；主源是上游 cherry-studio v1.9.11（§B' 待补）与 v2（§B）。其中与内部缺口重合的个别项已在 Tier 表以真实来源登记，纯周边来源项不进推荐，需要时回本节翻档案。
>
> 勘误存档：Academic-Agents-Studio 实为 gpt_academic fork + Qwen-Agent/MCP 扩展；chatbox 目录系用户主动清空。

**档案要点**（证据路径略，详见子调研原文）：
- deepwrite：Agent 写入 diff 审阅+审阅导航、发送前上下文预览、检查点/草稿恢复、修订段落 diff、选中文本→对话引用、快捷键帮助页、角色预设、对话导出。
- gpt_academic：多模型同问、虚空终端意图路由、PDF 对照翻译、ArXiv 精翻、降 AI 痕迹、整库源码解析、语音对话、Mermaid 生成、会话存档文件。
- Paper-Agent：逐卡片真实 token 记账（绝不按长度估算）、长任务检查点续跑（checkpoint_halt）、chunk 级引用锚定+回读验证、GB/T 7714 参考文献、模型档位分阶段配置、"请只回复 OK"连通性测试。

### D. 业界同类产品调研（Open WebUI 等，2026-02 官方功能面）

来源：[Open WebUI Features](https://docs.openwebui.com/features/)、[Cherry Studio v1↔v2 差异文档](https://docs.cherryai.com.cn/docs/en-us/cherry-studio/installation/v1-v2-feature-differences)。

| # | 候选 | 它做什么 | Re_Cherry 现状 | 初判 |
|---|------|----------|----------------|------|
| D1 | 多模型同屏对比 | 两个模型并排跑同一提问，肉眼对照 | 有 switchModelAnswer 串行 fork，无同屏并排 | 可选 |
| D2 | 消息队列（模型响应中继续打字排队发送） | 响应未完时输入不锁死，消息排队自动发 | 已核：`InputbarCore.tsx` `isSendDisabled = noContent \|\| isLoading \|\| searching`，流式中发送被禁用，排队不存在 | 值得 |
| D3 | 定时任务/自动化 prompt（cron） | 按计划自动运行提示词 | v0.4.6 已明确 defer（cron） | 值得，接 dsh-jobs? |
| D4 | 用量/成本看板 | token 消耗、消息量、费用聚合 | 消息级 usage 已持久化，无聚合视图 | 值得 |
| D5 | 语音输入 STT / TTS 朗读 | 麦克风转文字、回复朗读 | 无（模型黑名单里还显式排除 tts 模型） | 可选（成本高） |
| D6 | 提示词模板动态变量 | `{{USER_NAME}}`/`{{CURRENT_DATE}}` 注入 | 快捷短语已有，变量未见 | S，可选 |
| D7 | 话题标签/文件夹 | 会话组织维度 | 置顶已有（`topic.pinned`）；标签/文件夹未见 | 可选 |
| D8 | ~~草稿恢复~~ | —— | 已存在：`INPUTBAR_DRAFT_CACHE_KEY`（24h TTL，`Inputbar.tsx`） | 划掉 |
| D9 | 知识库混合检索（BM25+向量+rerank） | 检索质量 | 向量 O(n)，rerank 只是类型形状 | v1 性能窗口处理 |

### E. 内部已知缺口（来自 CLAUDE.md / 路线图 / v0.4.6-1 遗留）

| # | 缺口 | 说明 | 去向建议 |
|---|------|------|----------|
| E1 | 正文流式卡顿 | v0.4.6-1 取证仪器已布，根因未定 | v1 审查窗口必办，不是候选 |
| E2 | Browser-MCP | v0.4.6 明确 defer 的候选 | 本版重新评估 |
| E3 | cron 定时 | v0.4.6 明确 defer 的候选 | 本版重新评估（见 D3） |
| E4 | MCP OAuth | v0.4.6 明确 defer 的候选 | 本版重新评估 |
| E5 | 知识库 rerank 仅类型形状 | 检索质量天花板 | v1 性能窗口 |
| E6 | 快捷助手独立通路 | 与主通路双轨，长看是分叉成本 | v1 统一审查再议 |
| E7 | **全局记忆从未完全接线**（用户点名，已实锤——换 DSH 内核通路时丢了消费端） | **上游 V1 四件套（全接通）**：① `aiCore/plugins/searchOrchestrationPlugin.ts`（请求编排：`globalMemoryEnabled && assistant.enableMemory` 时检索注入，3 处判定）② `aiCore/tools/MemorySearchTool.ts`（模型检索工具）③ `AssistantMemorySettings.tsx`（每助手记忆开关）④ `services/MemoryProcessor.ts`（轮后事实抽取管线 getFactRetrievalMessages→合并 update）。**fork 现状（全断）**：`globalMemoryEnabled` 开关零消费者（`MemorySettings.tsx:600`）；`Assistant.enableMemory` 成孤儿字段（`types/index.ts:69`，仅测试 mock 引用）；`MemoryService.search/add` 只有设置页 CRUD；`factExtractionPrompt` 无调用方；消息块 `memories` machinery 无生产者。现仅 v0.4.6 工作模式 `memory` 工具（每助手 FACT/JOURNAL 文件）活着——工具型记忆 ≠ 全局记忆 | **候选最前段**：按 fork 惯例回接——memory_search 走条件挂载模式（同 knowledge_search 的 messageThunk 并入路径）+ 注入判定 + 轮后抽取轻通路；或按用户裁决砍掉全局记忆只留工具 |

## 3. 汇总评估矩阵（纠正版：上游 V1/V2 为主源，内核件按必要性重评）

来源标注约定：**上游** = cherry-studio v1.9.11 / v2（关键上游，候选主源）；**内部** = 本仓可观察缺口（E 组/实测）；**业界** = 同类产品对照；内核 = DSH 官方件（须过必要性关）。

### 内核官方件必要性重评（回应用户质疑：存在 ≠ 需要）

| 内核件 | 对照项目本体的判定 |
|--------|--------------------|
| compaction 套件 | 个人使用上下文可控；已有 webSearch 结果压缩 + thinkingReplay 修剪。无痛点证据，装整套计量+压缩栈属内核膨胀 → **撤出**，留观察项 |
| 上下文占用指示 | fork 已有 TokenCount（`Inputbar` 导入），上游 V1 就有 → **划掉（已存在）** |
| 斜杠命令 dsh-commands | 输入区已有技能/@提及/快捷短语，平行新 UX 面必要性存疑 → **按需** |
| permission-presets + session-projection（work-mode 迁内核） | 现行工作模式已工作（话题级 + freshness 通道），迁移是架构洁癖非用户价值，且引新栈 → **不动** |
| spill/retention | webFetchTool 注释点名的截断语义统一是真实小痛点，但为它引 local+policy 两件略重 → **S 级顺手项（可选）**（2026-09-30 用户裁决「工具输出超限落盘」不做后，spill 载体随之撤出清单，见 Tier 3） |
| guard 防循环/工具超时 | pwsh 自带 timeout，toolEscalation 已管节奏 → **按需** |
| dsh-schedule 定时 | v0.4.6 defer 是既成裁决，无新痛点证据 → **维持 defer，除非用户要** |
| run_code | pwsh 外的 JS 计算空缺真实，个人频率存疑 → **可选** |
| subagent/workflow/plan-mode | L 级大件 → **v1 后生态期** |

### Tier 1 —— 建议冻结进 v1 范围（内部缺口 + 上游 V1/V2 挖掘，10 项；2026-09-30 用户裁决后）

| 优先 | 候选 | 来源 | 成本 | 一句话理由 |
|------|------|------|------|-----------|
| 1 | **全局记忆接线**（E7）——**方向已裁决：接线（2026-09-30）** | **内部**实锤 + **上游** V1 四件套原生形态 | M | 按条件挂载惯例回接：memory_search 工具（同 knowledge_search 的 messageThunk 并入路径）+ 轮前注入判定（globalMemoryEnabled && assistant.enableMemory）+ 轮后抽取轻通路 |
| 2 | **追问队列 + Steering**（生成中排队追问/插入当前轮/编辑移除） | **上游** V2（§B+ α1） | M | 高频痛点升级：生成中打字不再是死局；排队自动发可先行，steer 看内核支持 |
| 3 | 消息级原地翻译（译文块随消息） | **上游** V1（§B' V1-1） | M | 长外文回复不切页对照 |
| 4 | Obsidian 集成（vault 进知识库 + 导出归档） | **上游** V1（V1-3） | M | 与已有知识库/导出体系天然衔接 |
| 5 | DXT MCP 扩展一键安装 | **上游** V1（V1-4）+ V2 MCP 导入互证 | S-M | 复用 Claude 生态现成扩展 |
| 6 | 电源事件守护（关机/休眠收尾） | **上游** V1（V1-5） | S | 备份/会话不再烂尾 |
| 7 | 用量统计面板 | **上游** V2 + **内部**（usage 已持久化无聚合） | M | 数据已产生只是没人记 |
| 8 | 全局正文搜索 | **上游** V2 + **内部**（历史页只能按标题翻） | M | Cmd+K 跨话题/正文；可与 §B+ α7 历史记录管理合并立项 || 9 | 翻译页偏好项回补 | **上游** V1 缩水（V1-7，fork 注释已留钩子） | S-M | 自定义小语种/复制习惯 |

> 用户裁决移出（2026-09-30，理由见 Tier 3）：助手预设商店、消息级分支、图片 OCR、自动重试+备用模型降级链。
> **核实为已有、撤销候选（2026-09-30）**：~~模型健康检查~~——fork 已有完整体系（`HealthCheckService.ts` + `ModelList/useHealthCheck.ts` 挂在模型列表 + `HealthStatusIndicator` 组件族 + `ApiKeyListPopup`；弹窗配置多 key 轮询/并发/超时，逐模型状态更新，汇总 toast）。V2 侦察将其列为缺口时未核对 fork 自身 ProviderSettings 表面，实装前逐项核实基线的又一教训。
> **核实为已有、降级（2026-09-30）**：~~全局正文搜索~~——fork 历史页已有完整跨话题消息搜索（`Dsh_SearchMessages` 内核 FTS + 关键词组/全词匹配/排序 + 片段 + 点击进话题/消息闭环 + `search_message`/`search_message_in_chat` 双快捷键入口）；V1-diff 的「历史页只能按标题翻」为误判。剩余缺口仅 Cmd+K 浮层形态（体验增量）→ 降 Tier 2。**Tier 1 实装清单余 8 项。**
> **搁置（2026-09-30 用户裁决）**：系统截图工具（§B++，移植评估已备）——其他功能处理好了再做，届时从评估报告直接开工。

> 用户裁决移出（2026-09-30，理由见 Tier 3）：助手预设商店、消息级分支、图片 OCR、自动重试+备用模型降级链。

### 实装进度（v0.4.7，2026-09-30 起）

| # | 项 | 状态 |
|---|-----|------|
| 1 | 全局记忆接线 | ✅ 完成：memory_search 内核工具（条件挂载，门=全局开关&&enableMemory）+ 轮后抽取管线（memoryProcessor.ts，V1 MemoryProcessor 同构裁剪：差分前直检候选/只取最近一轮/无 zod 依赖）+ 助手工具页开关 + turn/end 触发；14 测试 + 双 typecheck + 静态 10/10 全绿 |
| 2 | 追问队列（Steering 留待内核 mid-turn 缝） | ✅ 完成：**用户裁决仅工作模式启用**；followupQueue 切片（blacklist 不持久化）+ 泵（turn/end 成功后按序发）+ Inputbar 拦截 + Dock 面板；5 测试 + 双 typecheck + 静态全绿 |
| 6 | 电源事件守护 | ✅ 完成：PowerMonitorService（suspend/resume/shutdown 轻量收尾 App_SaveData；Windows 关机缺口如实记录）；6 测试 + 双 typecheck 绿 |
| 3 | 消息级原地翻译 | ✅ 完成：TRANSLATION 块类型回归 + Dexie `message_translations`（v17）持久真源 + Redux 块投影 + 水合钩子；LLM 走翻译页轻通路（lightStream + state.llm.translateModel）；15 测试 |
| 5 | DXT MCP 一键安装 | ✅ 完成：DxtService 移植（node-stream-zip 既有依赖）+ `Mcp_UploadDxt` IPC 三层 + stdio 启动前按 dxtPath 重解 + 修上游 4 处缺陷（清理按 dxtPath/npx 判定按解析后 cmd/重名双查/临时文件清理永假）；28 测试 |
| 10 | 翻译页偏好项回补 | ✅ 完成：自动复制/自定义指令/自定义语言三节进设置抽屉（settings 键 + migrate 226 + AnyTranslateLangCode 宽化 + 校验器）；7 测试 |
| 7 | 用量统计面板 | ✅ 完成：usageStats 纯聚合（7 测）+ usageStore（Dexie v18 usage_records）+ kernelChat 回合收尾记录点（失败/中断回合 token 照记）+ 设置页 UsageSettings（范围预设/总量卡/按日条形/按模型）；双 typecheck + 静态全绿 |
| 8 | ~~全局正文搜索~~ | ❌ 降级：实装前核实 fork 历史页已有完整跨话题内核搜索（Dsh_SearchMessages 闭环）；Cmd+K 浮层形态降 Tier 2 |
| 9 | ~~模型健康检查~~ | ❌ 撤销：实装前核实 fork 已有完整体系（HealthCheckService + ModelList 接线），侦察误判 |
| 4 | Obsidian 集成 | ✅ 完成：ObsidianVaultService（零依赖 fs，13 测）+ 2 只读 IPC + 导出弹窗（obsidian://new&clipboard deep link，无 fs 写通道）+ Topics 空壳填真 + 消息级/笔记级条目 + 默认 vault 设置节（migrate 227） |

**终态（2026-09-30 实装完毕）**：Tier 1 全部 8 项（两项核实已有撤销后）全部落地并过门禁——双 typecheck EXIT 0、静态套件 10/10、全量测试 227 文件/2922 用例全绿、lint 链清理完毕（含 eslint --fix 半途改写 shadcn.tsx 的修复与 HEAD 既有 totalTimer prefer-const 修复）。**并发纪律执行记录**：i18n locale / databases/index.ts / IpcChannel.ts 单写者——子代理经 `tools/i18n-pending-*.json` 协议交付键，父代理统一合并后已消费删除。

**并发纪律**：i18n locale / databases/index.ts / IpcChannel.ts 单写者——子代理把键/表/通道写进待合并文件（tools/i18n-pending-*.json），父代理统一落盘。

### Tier 2 —— 可选/按需（v1 期间或之后）

| 候选 | 来源 | 成本 | 时机建议 |
|------|------|------|----------|
| **【搁置】系统截图工具** | **上游** V2 深挖（§B++） | L（砍配置 M） | **用户裁决搁置：其他功能处理好了再做**；移植评估报告已存 reports/，开工即用 |
| 统一资源中心（合并方案：助手/技能/预设导入导出 + 受管工具管理共用一壳；依赖管理不独立立项——并入 Code Mate 受管工具体系增量） | **上游** V2（α3+α5 合并评估） | M | 助手/技能页成熟后做聚合 |
| 代码块可编辑+可执行 | **上游** V2（α6） | M | 执行可骑现有 pwsh 工具，不必新执行器 |
| 对话历史记录管理页（跨助手话题表+批量迁移） | **上游** V2（α7） | M | 可并入全局搜索立项 |
| 文件页表格视图 | **上游** V1 缩水（V1-9） | S | 顺手 |
| PDF 保留版式翻译（BabelDOC） | **上游** V2（α4） | L | 重件；翻译页加 PDF 模式 |
| S 级小件堆（长文本粘贴转文件/随打随译/消息分区编辑/提示词绑定+AI 润色+系统变量/智能分段/xlsx 预览/子窗口/本地自动备份计划/导出 MD 细粒度/大纲锚点/quickPanel 作用域/翻译历史+语种检测双引擎/拼写检查/忙时阻止睡眠/更新测试通道） | **上游** V2（§B+ 小件堆） | 各 S | v1 期间按顺手程度捞 |
| 体验小件（提示词动态变量/话题标签/快捷键帮助页） | **业界**/**存档** | S | |
| 发送前上下文预览 / RAG chunk 锚定 / 检查点续跑 / 会话存档 | 存档（§C） | S-M | 按需 |
| run_code / 斜杠命令 / guard | 内核（必要性重评=按需） | M/S | 出现真实需求再接 |
| 混合检索（BM25+向量+rerank 落地，含 V2 智能分段/overlap 参数） | **内部** E5 + **业界** + V2 | M/L | v1 性能窗口统一处理 |
| session-query FTS5 / agent-instructions / subagent / workflow / plan-mode | 内核 | S-L | v1 之后生态期 |
| compaction 套件 | 内核 A6 | M | **观察项**：v1 真实长会话痛点出现再启用 |

### Tier 3 —— 明确不建议（记录理由防重提）

| 候选 | 理由 |
|------|------|
| **助手预设商店 + 新建助手弹窗** | **用户裁决不做（2026-09-30）** |
| **消息级分支** | **用户裁决不做（2026-09-30）：fork 现有机制（话题级分支+BranchGraph+parallel fork）实现更好** |
| **图片 OCR 通道** | **用户裁决不做（2026-09-30）：现有实现（LocalPaddle+识图+文档通道）更好** |
| **自动重试 + 备用模型降级链** | **用户裁决不做（2026-09-30）：意义不大** |
| **工具输出超限落盘**（V2 offloader；内核 spill 载体随之同撤） | **用户裁决不做（2026-09-30）** |
| **Code 页多 CLI 后端** | **用户裁决不做（2026-09-30）** |
| **网页标注（minapp 注解层）** | **用户裁决不做（2026-09-30）** |
| **LAN 局域网传输** | **用户裁决不做（2026-09-30）** |
| GitHub Copilot 接入 | fork 有意裁撤的子系统（CLAUDE.md 明载），不回头 |
| Agent 运行时切换（DSH/Claude/Pi） | fork 单运行时即 DSH，切换面无意义；V2 的 dsh-bridge 接口留档备查 |
| work-mode 迁内核日志（permission-presets+projection） | 现行机制已工作；迁移无用户价值、徒增内核面 |
| 上下文占用指示独立立项 | TokenCount 已存在 |
| 语音输入 STT / TTS 朗读 | 成本高、个人桌面需求弱 |
| IM 渠道接入 | L 且运维成本高，个人单机定位偏移 |
| API 网关 + 设备配对（LAN 互传已随 2026-09-30 裁决整体不做） | L，多设备场景非主目标 |
| 内置通用浏览器 | 与小程序页定位重叠 |
| 多模型同屏并排对比 | 与 DSH 单路径相性一般；已有 switchModelAnswer 串行 fork |
| 本地 Embedding 模型内置 | 知识库已有嵌入管线；个人场景收益低 |
| OTLP 全链路追踪 UI | 已有 trace 窗栈；开发者向 |
| codeMode 工具代码化调用 | 内核协议改造、相性未知 |
| 虚空终端意图路由 | DSH 内核本身就是意图路由器 |
| dsh-bash 系 | Windows 场景 pwsh 已覆盖 |
| dsh-authorization | 仅 OAuth 提供商才需要 → 与 MCP-OAuth（E4）合并暂缓 |
| 定时任务（本轮维持 defer） | v0.4.6 用户裁决仍有效，无新痛点证据 |

## 4. v0.4.7 交付形态（待用户裁定，不抢跑）

- **清单本体已定稿**：本文件即"冻结前最后盘点"（V1.9.11 对比已并入 §B'/Tier 表）。
- **待用户示下**：① 全局记忆的裁决方向（接线 / 砍掉留工具）；② Tier 1 取舍；③ 提交与 tag 时机。

## 5. 明确不建议项

见 Tier 3 表（每条已带理由）。备注：参考资产中 V1.9.11/V2 为关键上游（候选主源），其余项目仅辅助印证；参考应用调研原文已存档于 §C。
