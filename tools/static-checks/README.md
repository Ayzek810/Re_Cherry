# Re_Cherry 静态校验套件（十项）

> **位置纪律**：本套件**故意放在仓库之外**（`E:\Workspace\project_REC\tools\static-checks\`），
> 因此**永远不会被提交**到 Re_Cherry 仓库里——它是开发者的工具，不是 fork 的产物。
> 这与 v0.2.4-1 时代的设计一致（当时的套件在 `E:\Workspace\Re_Cherry\tools\static-checks\`，
> 随工作区搬迁丢失，v0.3.0-1 后续按同一设计重建）。

## 为什么要它

本项目的开发环境长期**没有 node_modules、不能跑 pnpm**，于是 `pnpm lint` / `typecheck` / `test`
全都不可用。但"删了还在被引用的东西""改了名字没改引用""i18n 键被剪没了"这三类回归，
恰恰是纯文本层面的问题——**不需要类型检查器也能抓**。十项检查全部只用 Node 内置模块，
零第三方依赖（**不要为了方便引入 yaml / jsonc-parser / typescript 之类的包**，
那会把这套工具重新绑回依赖树）。

## 用法

```powershell
# 用真实的 Node（本项目要求 >=24.11.1；DSH 自带的 24.9.0 不满足）
node tools/static-checks/run-all.js

node tools/static-checks/run-all.js --only=check-imports     # 只跑一项
node tools/static-checks/run-all.js --quiet                  # 只打印结论与失败行
node tools/static-checks/check-i18n-keys.js --update-baseline    # 刷新 i18n 基线
node tools/static-checks/check-i18n-dynamic.js --update-registry # 刷新动态键形状注册表
```

仓库根由本套件自身位置向上解析（找到同时含 `package.json` 与 `src/main` 的目录），因此放在仓库内、仓库外或任何副本里都能跑；可用 `RC_REPO=<path>` 覆盖。工作区根取仓库根的上一级——上游参考树等外部资产按约定放在仓库旁。
部分检查支持 `node <check>.js` 单独运行（打印结论并以退出码表态）。

## 十项各自守什么

| # | 检查 | 守的东西 | 已知假阳性 / 边界 |
|---|---|---|---|
| 1 | `check-imports` | 每个 import / export-from / require / dynamic-import 说明符都在磁盘上解析得到：相对路径（含 NodeNext 的 `./x.js`→`./x.ts`）、别名（`@main` `@renderer` `@shared` `@types` `@logger` `@mcp-trace/*`，按文件归属选 node/web 两张表）、`?url`/`?raw` 等查询后缀、资源文件、裸包（已安装或已在 `package.json` 声明）、`node:` 内置 | 裸包只校验"已安装或已声明"，不校验子路径 `exports` 映射；`export * from` 的目标也算说明符（会一起查）。 |
| 2 | `check-symbols` | 每个 `import { a } from '<本地 TS 文件>'` 的 `a` 在目标文件里真的导出。覆盖本仓三种导出形状（`export const X`、`export const { a, b } = slice.actions`、`export { default as X, type Y } from './z'`），并跟随 `export * from` 递归解析 | 只查**具名**导入与 type-only 具名导入；`import X from`（默认导入）不查；目标是 `.js/.mjs/.cjs` 时跳过（CJS 导出形态无法静态判定）。正则级实现，不解析 AST——因此**不要**指望它查函数内局部导出之类的东西。 |
| 3 | `check-syntax` | 每个 `.ts/.mts/.cts` 都能被 `module.stripTypeScriptTypes` 解析。先 `strip` 模式，命中"strip-only 不支持"（enum/namespace/参数属性/装饰器）时用 `transform` 复检，两者都失败才是真语法错 | **`.tsx` 不在覆盖范围**（Node 剥离器不支持 JSX），`.js/.mjs/.cjs` 也不查。它**查不出类型错误**——类型问题只有 `pnpm typecheck`（tsgo）能查，见下方"纪律"。 |
| 4 | `check-configs` | `package.json` / `tsconfig*.json` / `.oxlintrc.json`(JSONC) / `biome.jsonc`(JSONC) / `pnpm-workspace.yaml` / `electron-builder.yml` 可解析、无 UTF-8 BOM；`patches/` 与 `patchedDependencies` **1:1**；`pnpm-lock.yaml` 的 `patchedDependencies` 与 workspace **一致**；每个被引用的 patch 文件真实存在；`version` / `packageManager` 形态正常 | YAML 用的是"极简子集解析器"（缩进映射+序列+标量）。遇到块标量 `|`/`>`、锚点 `&`/`*` 会记为字符串标记而不是报错。lockfile 只抠 `patchedDependencies` 块（整文件 2 万行不整解析）。 |
| 5 | `check-i18n-parity` | `en-us.json` 与 `zh-cn.json` 的**叶子键集合**完全一致 | 与 `pnpm i18n:check` 的 parity 部分等价（此处在无依赖下也能跑）。只比键集，不比文案质量。 |
| 6 | `check-main-i18n` | **主进程能读到自己的字符串**：被对象值解构的命名空间（`const { tray: trayLocale } = locale.translation`，含别名）在两语包里都存在且成员是字符串；该命名空间上被点取的成员（`trayLocale.show_window`）真实存在；主进程里 `t('a.b.c')` 字面量两语可解析；`locales.ts` 仍引用两个语言包 | 本项守的是一次**真实事故**：主进程按对象值取文案，`'tray.show_window'` 这种字面量在源码里根本不存在，任何"按字面量引用"驱动的剪枝都会整段删掉命名空间，而普通文本检查看不见这个损失。假阳性来源：`local.member` 形式的非文案对象（已排除 `translation`/`length`）。 |
| 7 | `check-i18n-keys` | 源码里**以语言包命名空间开头**的点号字符串字面量，在两语包里都能解析（i18next 复数/上下文感知：`key` 缺失但 `key_one`/`key_other`/`key_male` 存在即算解析） | **基线制**：比对 `i18n-baseline.json`，只让**新增缺失**失败；存量缺口记在基线里不阻塞（否则门禁永远红）。基线与注册表是**生成物**，`--update-baseline` 刷新。已内置三类**假阳性过滤**（并在 note 里如实计数）：① 文件名/资源名（`settings.json`、`notes.txt` — 首段撞上同名命名空间）；② 存储键（`keyv.get('memory.wait.settings')`）；③ 主机名（`files.domain.net`）。**2026-09 的基线 = 9 条真缺口，不是噪音**：其中 5 条调用点没有任何回退（用户会直接看到裸键）。 |
| 8 | `check-i18n-dynamic` | 模板字面量动态键（`` t(`error.${code}`) ``）的**形状**必须在 `i18n-dynamic-registry.json` 里登记；登记了 `expandsTo` 的，每个目标键两语可解析 | 未登记形状 → 失败；已登记但未枚举 `expandsTo` → 只记 warning（除非写了 `notEnumerable` 理由，则记为 note 通过）。会话导入器注册表在本 fork 存在，其 `import.<name>.assistant_name` 键会被逐个核对 |
| 9 | `check-upstream` | 与**上游参考树**逐条对账 `upstream-policy.json` 里的常量表（默认 10 个 `provider.ts` 列表）。规则：`equal`＝必须与上游一致；`subset-of-upstream`＝允许少（provider 下线），**不允许出现上游没有的条目** | 上游树缺失（`参考资产/` 不在）时**整体跳过**并记 note，套件在无参考树的机器上照样能跑。指定路径：`--upstream=<path>` 或 `RC_UPSTREAM`。本项是 v0.3.0-1 用**人肉对账**发现两类误删（`SUPPORT_URL_CONTEXT_PROVIDER_TYPES` 少 gemini/vertexai/azure-openai、`NOT_SUPPORT_API_KEY_PROVIDER_TYPES` 被清空）之后固化的机器门禁；局限：只比对彼此独立的常量表，比不了函数体 |
| 10 | `check-package-runtime-closure` | 从根 `package.json` 的 `dependencies ∪ optionalDependencies` 出发，沿每个包 manifest 的**正则边**（dependencies+optionalDependencies）BFS 收集闭包；闭包内每个包的**运行期边**（dependencies + peerDependencies，非 optional）必须全部落在闭包内或根集合（manifest 解析 = 顶层 junction 优先，回落 `.pnpm/*/node_modules/<pkg>/package.json` 扫描——pnpm 自己的解析方式） | **有意严于 electron-builder 的实际收集器**（后者以 `pnpm list --prod --json` 报告层为源再按正则边过滤，实测可漏可宽：v0.3.1 里 dsh-invariants 无任何正则边却在 asar 里，入包通道未定性记于未清债）。本门禁只认正则边，于是 dsh-invariants 同样要求根声明——语义正解：运行期要用的 peer 本就该由宿主显式满足。**自跳过**：`node_modules/.pnpm` 不存在时整体跳过并记 note（无安装树时无意义）。**豁免**：确非运行期的边加 `EXEMPT_EDGE_TARGETS` 白名单（当前为空），逐条写 why。红证即事故本身：v0.3.1-1 修复前 61 条边 / 9 包 EXIT=1，`dsh-output-retention` 正是装机崩溃的缺件；判据 `§4.16` |

## 纪律（踩过坑才写下来的）

1. **绝不因为"文本里没出现"就剪枝**。一条文案/键/barrel/副作用导入的消费方式至少有六种：
   字面量、**对象值**、模板字面量、变量键表、barrel 转发、副作用导入。
   `check-main-i18n` 与 `check-i18n-dynamic` 就是为前三种之外的盲区设的。
2. **语法级检查不能替代类型检查**。v0.3.0-1 亲历：`stripTypeScriptTypes` 13/13 全过，
   真机 `tsgo` 仍报出 3 个类型错。**任何"静态套件全绿所以类型没问题"的结论都是假绿。**
   有依赖时请务必另跑 `pnpm typecheck`。
3. **删除/改名批次的验收顺序**：先跑套件 → 再跑 `pnpm typecheck`（有依赖时）→
   最后跑一次功能烟测。套件只能证明"引用没断"，证明不了"行为没变"。
4. **报告要当真**：失败项要么修代码，要么改基线/注册表并**在提交信息里说明为什么**。
   把基线当成"消音器"，套件就废了。
5. 本套件是**正则/文本级**实现，天生不解析 AST。它擅长"抓断链"，不擅长"证明正确"。

## 生成物

| 文件 | 说明 |
|---|---|
| `i18n-baseline.json` | i18n 字面量键的存量缺失基线（首次运行自动生成；**2026-09 收尾时已为 0 条**——v0.3.0-1 把 9 条真缺口补齐后清空） |
| `i18n-dynamic-registry.json` | 动态键形状注册表（首次运行自动生成） |
| `upstream-policy.json` | 上游对照策略：每条 `{file, constant, rule, why}`，**why 是硬要求**（评审时单独看它） |

三者都属于"工具状态"，改它们等于改门禁口径，**评审时要单独看**。
