# 质量门禁

改完代码就跑门禁。每种门禁覆盖不同面，互相不能替代。

## 命令与实测耗时

实测环境：Windows / Node 24 / pnpm 工作区已安装依赖。

| 门禁 | 命令 | 实测 |
|---|---|---|
| 类型检查（主进程侧） | `tsgo --noEmit -p tsconfig.node.json --composite false` | 0.9 s |
| 类型检查（渲染层侧） | `tsgo --noEmit -p tsconfig.web.json --composite false` | 1.3 s |
| Lint 1 | `oxlint --deny-warnings` | 3.5 s |
| Lint 2 | `eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts` | 14 s（无缓存）/ 1~2 s（带 `--cache`） |
| 格式 | `biome format` 与 `biome lint` | 各约 1 s |
| 静态套件 | `node tools/static-checks/run-all.js` | 39 s |
| 单元测试（全量） | `vitest run --silent` | 170~200 s（369 个文件 / 3645 条） |
| 单元测试（定向） | `vitest run --silent <文件路径…>` | 1~15 s |
| 生产构建 | `electron-vite build` | 4~8 s |

## 两档用法

**改动期（快档，约 20 s）**：`biome format` + `biome lint` + `oxlint --deny-warnings` +
两个 `tsgo` + 静态套件 + 受影响文件的定向测试。

**收尾与发布（全档，约 4 min）**：快档全部 + `eslint` + 全量 `vitest` + `electron-vite build`。

改一行不必跑全量。收尾、提交发布点、或动过共享代码（内核集成层、`packages/shared/`、
构建配置）时跑全档。

## 静态套件守什么

`tools/static-checks/` 是零依赖的 Node 脚本，十项检查各有明确的保护面。实测耗时见括号。

| 检查 | 保护面 | 耗时 |
|---|---|---|
| `check-imports` | 每个 import / export-from / require / 动态 import 的说明符都能在磁盘解析 | 2.5 s |
| `check-symbols` | 每个具名导入的名字在目标文件里真的导出 | 6.4 s |
| `check-syntax` | 每个 `.ts` 都能被 Node 的类型剥离器解析（语法级） | 0.7 s |
| `check-configs` | 配置文件可解析、无 BOM、`patches/` 与 lockfile 1:1 | 11 ms |
| `check-i18n-parity` | 两个语言包的叶子键集合一致 | 9 ms |
| `check-main-i18n` | 主进程按对象值或字面量取到的文案真实存在 | 0.6 s |
| `check-i18n-keys` | 点号键字面量在两语都能解析（基线制） | 1.4 s |
| `check-i18n-dynamic` | 模板字面量动态键的形状已登记且可展开 | 1.3 s |
| `check-upstream` | 与上游参考树对账常量表（无参考树时整体跳过） | 1 ms |
| `check-package-runtime-closure` | 根 manifest 出发的依赖闭包覆盖每个包的运行期边 | 26.3 s |

套件支持 `--only=<检查名>`、`--quiet`，并打印逐项耗时。仓库根由脚本位置向上解析，
因此放在任何位置都能跑；`RC_REPO` 可覆盖。

## 每道门禁不能替你做什么

- **静态套件不是类型检查**。它只做语法级与引用级判断。语法全绿而 `tsgo` 报错是常态。
- **`check-syntax` 不覆盖 `.tsx`**（Node 的剥离器不支持 JSX）。
- **Lint 不是行为证明**。行为改动要有行为级证据：真机样本，或一条测试。
- **构建不等于能跑**。打包后再启动一次，打开聊天页与一个懒加载路由。

## 测试纪律

- 测试池用 forks。threads 池在本机崩溃。
- 不要用耗时当回归信号。用退出码与用例计数。
- 全量套件报红时，先在空闲机器上复跑一次再判定回归。
- 删文件、改名、改 import/export 面、改 i18n 键、改构建配置之后，跑静态套件。
- **删之前列出六种消费形态**：字符串字面量、对象值查表、模板字面量、变量键表、
  barrel 转发、副作用导入。然后用两种互不共享盲区的方法确认（例如别名与相对路径各查一遍）。
  i18n 是常见陷阱：主进程按对象值读键，字面量扫描看不见这类消费方。
