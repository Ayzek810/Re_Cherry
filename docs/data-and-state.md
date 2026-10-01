# 数据与状态

应用数据分三处：内核的 SQLite 与会话日志、主进程的文件、渲染层的 Dexie 与 localStorage。
只有第一处是会话真相。

## userData 布局

`bootstrap.ts` 先重定向数据目录，再启动其余部分。开发模式下目录名带 `Dev` 后缀。

| 路径 | 内容 | 真源？ |
|---|---|---|
| `kernel/sessions.db` | 内核会话日志（SQLite）。聊天的唯一真相源 | 是 |
| `kernel/topics.json` | 话题注册表 | 是（按话题） |
| `kernel/settings.json` | provider 路由同步快照 | 否（可重建） |
| `app-update.json` | 应用更新偏好：更新源 / 自动下载 / 被忽略的版本 | 否（丢了回到默认） |
| `provider-keys.json` | provider 密钥，`ProviderKeyStore` 加密存放 | 是（按密钥） |
| `Data/Files/` | 文件仓（含小程序自定义配置 `custom-minapps.json`） | 是 |
| `Data/Notes/*.md` | 笔记正文，纯文件 | 是 |
| `Data/CodeMate/` | 受管运行时与编码助手的工作区 | 是 |
| `Runtime/models/` | 本机 OCR 模型 | 否（可重下） |
| `logs/` | 主进程日志（按天轮转） | 否 |

## 渲染层持久化

| 存储 | 内容 | 规则 |
|---|---|---|
| Dexie（IndexedDB） | 文件、笔记索引、短语、翻译、绘画、用量等 | 表结构在 `src/renderer/src/databases/index.ts` |
| redux-persist → localStorage | UI 切片。键固定为 `persist:cherry-studio` | 见下方纪律 |
| localStorage（其他） | 渲染层临时状态 | 不进持久化契约 |

`messages`、`messageBlocks`、`runtime`、`tabs`、`toolPermissions`、`userQuestions`、`followupQueue`
在 persist 的 `blacklist` 里。它们不写 localStorage。

## 持久化纪律

- 给已持久化的切片加字段，**必须**加 migrate 分支。`initialState` 到不了老用户：
  redux-persist 整体替换切片。
- 永远不要删 migrate 分支。`store/index.ts` 的 `version` 必须等于 `store/migrate.ts` 里最高的键。
- `blacklist` 的意思是"不写",不是"没用"。不要据此删代码。
- 读 `app.getPath()` 的 store 必须懒构造。模块顺序由打包器决定，不由源码顺序决定。
- persist 的 transform 会剥掉每一个非空 `apiKey`。保持这个行为。
- 解密失败表示"没有密钥"。不要加明文回退。

## 派生数据与真相源

引用载体块（citation carrier）是**派生数据**：它由工具结果里的 `presentationMeta` 生成，
重开话题即可重建。因此改它的载荷形状不需要数据迁移。

消息与块同理：它们不进持久化，靠内核日志重建。

## 密钥与凭据

- provider 密钥只进主进程内存与 `provider-keys.json`（加密）。
- 渲染层不保存 provider 密钥。persist 的 transform 在落盘前再剥一次。
- 文档处理通道、网络搜索、MCP 的服务商凭据走同一条路：随发送参数登记，只进主进程内存。

## 日志

- 用 `loggerService.withContext('模块名')`。不要用 `console.log`。
- 渲染层的 `info` 不落盘。取证性质的日志用 `warn`。
- 日志按天轮转，写在 `{userData}/logs/app.<日期>.log` 与 `app-error.<日期>.log`。
