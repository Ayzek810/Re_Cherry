# AI Assistant Guide

This file provides guidance to AI coding assistants when working with code in this repository. Adherence to these guidelines is crucial for maintaining code quality and consistency.

> **Re_Cherry** is a personal fork of Cherry Studio v1.9.11, heavily trimmed, with the chat/agent message path unified onto an in-process **DSH (DeepSeek Harness) Cordis kernel**. Most upstream Cherry Studio documentation (agent pages, MCP, knowledge base, apiServer, updater, Copilot, Pyodide, OVMS, selection toolbar, Drizzle agents DB) **no longer applies** — those subsystems have been removed. When in doubt, read the code, not this file's history.

## Guiding Principles (MUST FOLLOW)

- **Keep it clear**: Write code that is easy to read, maintain, and explain.
- **Match the house style**: Reuse existing patterns, naming, and conventions.
- **Search smart**: use the `grep`/`glob`/`read` tools and prefer semantic queries over guesswork — but scope every call (see *Retrieval must be scoped* under Loop Discipline).
- **Confirm before acting — but only where confirmation means something.** A direct instruction from the user **is** the authorisation: do the thing, then report. Do not re-derive "may I?" from the instruction you were just given, and do not ask twice for the same decision. Reserve the ask for what nobody asked for and cannot be undone: rewriting history, force-pushing, deleting data or files, or a structural change to how this project works. Re-reading the same material or re-asking the same resolved question is pure cost with no information in it — if you notice yourself doing it, act or ask once.
- **Never commit**: Finish your work and hand it to the user for acceptance. Do **not** run `git commit` / `git add` / `git push`.
- **Write the version report**: Every version/phase ends with a report at `<workspace>/docs/[version]_doc.md` (workspace `docs/`, *not* this repo's `docs/`). **Reports are never overwritten or moved by later versions** — each version keeps its own file in `docs/`, formatted to the shared template (结论速览 / 用户裁决 / 正文 / 事故与加固 / 验证 / 遗留). **Keep them tight, and keep them small:** this folder has reached 458 KB, the largest report is 182 KB / 970 lines, and one read of it is expensive — a report records decisions and evidence, not the process that produced them. Past ~40 KB or ~500 lines a report is being used as a log; split it by release instead of letting it grow. **Version containment:** a sub-release (`-1`, `.1`) does **not** get its own file — it nests inside its parent as a `## vX.Y.Z —— <subject>` section with the sub-release's own numbered sections demoted one level (`## N.` → `### N.`), and its version number stays visible so the record is still traceable. Anything still binding is distilled into `<workspace>/docs/经验教训.md` so each rule has one home and the reports keep only their own evidence.
- **Never leave a pointer-style instruction file**: a sibling file whose content is just the name of another instruction file (`AGENTS.md` containing the 9 bytes `CLAUDE.md`) is *loaded in addition to*, not instead of, its target. `dsh-agent-instructions` collapses siblings only when their trimmed content is byte-identical (`dedupInstructionFilesByDirectory`, SHA-1), so a pointer doubles the fixed per-request cost for zero information. Read `<workspace>/docs/README.md` before adding or moving anything under `docs/`.
- **No blind deletion**: Before removing code, prove it is unreferenced — run the static-check suite first, and only fall back to scoped grep (both are under *Sandbox Constraints* below). This fork's single biggest regression risk is deleting something that is still wired up.

## Sandbox Constraints (IMPORTANT)

Sandbox permissions depend on what the session was granted. When the gates are available, **run them for real instead of reasoning about them**. Two environment facts:

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node ≥24.11.1; DSH's bundled Node 24.9.0 is too old
$env:CI = "true"                        # avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

**`pnpm` does not run under the sandbox.** DSH's pnpm wrapper spawns a child process, so every `pnpm <script>` dies with `Error: spawn EPERM` (`pnpm-runner.mjs`) — deterministically, not intermittently. Do not keep retrying it or working around it by hand. **When a step genuinely needs pnpm, ask the user to grant full permissions for that command**, and say which command and why. Everything reachable without pnpm should be reached that way: `node tools/static-checks/run-all.js` for the suite, and `node_modules/.bin/` for the individual gates — `tsgo`, `vitest`, `oxlint`, `eslint`, `biome`, `playwright` and `electron-vite` are all present there, so read the `pnpm` script you wanted in `package.json` and invoke the same binary under `.bin/` directly (e.g. `typecheck` is two `tsgo --noEmit -p tsconfig.{node,web}.json` runs).

When they are **not** available, say so explicitly rather than claiming a run — the static-check suite documented below is the fallback (it needs no `node_modules`, no `pnpm`). Only then fall back to code review, and **scope it**: grep the specific symbol and path you touched across `src/` / `packages/` / `scripts/` / `tests/`, checking alias (`@renderer/...`), relative (`./x`) and barrel (`export * from './x'`) forms, then re-grep to prove zero dangling references. **Do not sweep the whole repository by hand when a gate can answer the same question in one command.**

**Shell gotcha (cost a failed history rewrite once):** the shell is **Windows PowerShell 5.1**, not PowerShell 7. `Get-Content` decodes as ANSI (a UTF-8 source file loses lines and turns Chinese into mojibake — `topics.ts` reports 1098 lines instead of 1172), and `>` / `Out-File` default to **UTF-16LE** (git then rejects the file with `a NUL byte in commit log message not allowed`). Read files with the file tools or `[System.IO.File]::ReadAllText` (UTF-8), write them with an explicit UTF-8 no-BOM encoder, and capture a command's exit code via `$LASTEXITCODE` — not through a pipeline, whose reported code can differ.

- **Run the static-check suite** (rebuilt during v0.3.0-1 as nine checks, lives **outside** this repo so it is never committed):
  ```powershell
  node E:\Workspace\project_REC\tools\static-checks\run-all.js
  ```
  It provides nine checks, and **all nine must be green** (exit code 0) after any batch of deletions/renames. `check-upstream` needs the upstream reference tree `E:\Workspace\project_REC\参考资产\cherry-studio v1.9.11` in place; it self-skips without it. In one line each: `check-imports` (every specifier resolves on disk) · `check-symbols` (every named import is really exported there) · `check-syntax` (`.ts` parses; **`.tsx` is out of scope**) · `check-configs` (configs parse, no BOM, `patches/` 1:1 with `patchedDependencies`) · `check-i18n-parity` · `check-main-i18n` (**the main process must be able to read its own strings** — it accesses locales by *object value*, so `'tray.show_window'` appears as no literal anywhere and a text-driven prune deletes the whole namespace) · `check-i18n-keys` (baseline-based: only *new* misses fail) · `check-i18n-dynamic` (template-literal keys must be registered) · `check-upstream` (reconciles constant tables against the upstream tree).
  **What each check does *not* cover, its known false positives, and the usage discipline are in `tools/static-checks/README.md` — read that before acting on a report.** **Never prune text-driven content (i18n keys, barrels, side-effect imports) without first enumerating every way that text can be consumed** — literal, object value, template literal, variable key table, barrel forward, side-effect import. See the incident record in that README.
- These checks catch broken references, syntax and config breakage, **not** type errors (e.g. a deleted state field still written in a file typed with `RootState`). When you delete a field/type, grep every consumer including `store/migrate.ts`, and prefer deleting the now-dead statements over adding `@ts-expect-error`.
- **Startup order is a safety property** (`src/main/index.ts`): `registerShortcuts()` and `await registerIpc()` must stay ahead of every cosmetic/optional initializer (tray, macOS app menu, telemetry), and those must stay wrapped in `try/catch` that only logs. A cosmetic failure must never take the app's basic usability with it.

## Project Rules Specific to This Fork

- **Kernel-plugin compatibility contract** is a hard acceptance gate: see `<workspace>/docs/内核插件兼容契约.md`. Never bypass the cordis `ctx.plugin` lifecycle or the public seams (`ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`, `ToolRuntime`, `session/event`). IPC handlers are thin forwarders only; do not scatter direct SQLite access outside the kernel.
- **The kernel session log is the single source of truth.** The renderer is a projection of kernel events. Any conversational state must be recoverable by folding the session log — no parallel sources of truth.
- **Topic membership is the kernel's to decide, never the renderer's** (v0.3.0-2). The renderer holds three persisted views of a topic (session log, kernel registry, Redux `assistants[].topics`), so it must not filter its own rows by its own timestamps: `utils/topicBranch.ts` fetches the authoritative set (`dshTopicList`, plus `dshTopicGet` for fork children) and `services/kernelTopics.ts` reconciles — materialize what the kernel has and the renderer lacks, prune what the kernel no longer knows, complete fields only from the kernel. **Only rows restored from the previous session may ever be judged stale** (`noteRestoredTopicIds` at rehydrate); a topic created in this process is simply not in the kernel yet until its first send (`ensureKernelTopic` registers it). The old `shouldShowTopicRow` / `BOOT_TIME` heuristic is retired and pinned by `services/__tests__/topicAuthorityGate.test.ts`.
- **`ensureAgent` may never silently create a session over an existing log** (v0.3.0-2). `sessionResumeFallback.ts` is the single decision point: a persistence existence query decides refuse-vs-create (fail-closed when the query itself fails), and the error's type is only a diagnostic label. See `sessionReadFailure.ts` for the classifier's deliberately narrowed role.
- **Every kernel query must tolerate the boot window** (v0.3.0-3). The main process creates the window and boots the kernel **in parallel** (`src/main/index.ts`: `createMainWindow()`, then `bootKernel()`), and the `dsh:*` handlers exist only after `initTopics()` — so an early renderer query legitimately fails with "No handler registered". That is a transient failure, not "the kernel does not know". Route such queries through `retryKernelQuery` in `utils/topicBranch.ts` (shared constants `KERNEL_QUERY_ATTEMPTS` / `KERNEL_QUERY_DELAY_MS`), and let a **definitive answer — including a negative one — return immediately**: retrying a settled answer only delays the caller. `null` keeps meaning "no answer after all attempts", and callers must not refuse or hide anything on `null`.
- **An unknowable state must never authorise a destructive action** (v0.3.0-4). `loadRegistry` distinguishes `loaded` / `absent` / `failed`, and `sweepOrphanSessions` asks `shouldSweepOrphans(outcome, registrySize)` before touching anything: a `topics.json` that **exists but cannot be read** means "the registry is unknown", so no persisted session can be proven an orphan and the sweep is skipped entirely (`logger.error`) — folding `failed` into `absent` once turned a single parse failure into a startup that physically deleted every session log. An unreadable registry is also copied to `topics.json.corrupt-<timestamp>` **before** anything can overwrite it, and a `{}`-shaped file (parseable, no `topics` array) counts as `failed` for the same reason. Same rule elsewhere: never treat "no answer" as "empty".
- **`src/main/kernel/topics.ts`** owns topics (= dsh session + agent) including the `destroyTurns` deletion engine. Structural operations go through the `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning` service seams (`src/main/kernel/services.ts`).
- **`src/renderer/src/services/kernelChat.ts`** is the event-projection bridge (its name is similar to the legacy `services/messageStreaming/**` layer — do not confuse them).
- Version roadmap and per-version goals live in `<workspace>/docs/当前任务总体规划.txt`.

## Loop Discipline (cost control)

- **A logic hunt needs a stop condition.** Words like "彻查" / "深入排查" have no endpoint, and an unbounded one is the single most expensive thing this project does — one past session ran 2,613 steps / 526 minutes / 1.8 亿 input tokens against 19 steps for a normal task. If the last several steps produced no new hypothesis or no new evidence, **stop and report**: what you ruled out, what remains, and what you would try next. Do not keep going on momentum.
- **Explore in a subagent, decide in the main session.** Bulk reading, multi-file surveys and parallel extraction belong in a subagent; the main session should receive conclusions. State plainly that a subagent redistributes cost, it does not reduce it.
- **Batch, don't repeat.** If you are about to do the same kind of operation a third time, switch to a script, a single batched command, or one scoped query instead.
- **Edit an injected instruction file in one pass.** Every `write`/`edit` to `CLAUDE.md` (or any `AGENTS.md`) re-injects the whole file into the next request — so think the change through and land it in one edit rather than iterating.
- **Prefer the gate over the hand audit.** One real type gate (`tsgo`, run directly — not through a `pnpm` script in the sandbox) is cheaper and stronger than grepping the tree by hand. Reach for grep only for what no gate answers.
- **Retrieval must be scoped.** `glob`/`grep` deliberately pass `--no-ignore` and exclude only VCS metadata (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl` — a hard-coded list), so `node_modules`, `dist`, `out` and any vendored tree **are** searched and `.gitignore` is not honoured. Measured: a bare `**/*.ts` from this repo's root returns **33,094** paths and shows the wrong 100 (all `node_modules`); the same pattern scoped to `src/` returns **458** and shows them all. So always pass `path`, pick the narrowest root that can hold the answer (`src/`, `docs/`, a single package), and never start a broad search from the repo or workspace root.
- **Never search `参考资产/` on your own initiative.** It holds ~170k files / 2.5 GB (upstream source trees plus their `node_modules`) and 71% of every `.md` in the workspace — an unscoped search there floods the result with irrelevant hits and returns the wrong 100. Two exceptions only: (a) the user explicitly asks you to compare against upstream or check what Cherry Studio did; (b) `tools/static-checks/check-upstream.js` reads `cherry-studio v1.9.11` by itself as a machine gate — that is not you searching. When you genuinely need it under (a), **delegate to a subagent**: name the one subdirectory in the prompt, require scoped searches, and require **conclusions only — never bring back the list of matched paths or file contents**, or the delegation has bought nothing.

## Development Commands (run on the user's real machine)

- **Install**: `pnpm install` — requires Node ≥24.11.1, pnpm 10.27.0
- **Development**: `pnpm dev` — Electron app in dev mode with hot reload (dev server port 5870, override with `DSH_DEV_PORT`; Hyper-V reserved port ranges drift across reboots — if EACCES, check `netsh interface ipv4 show excludedportrange protocol=tcp`). Dev mode does **not** install React/Redux DevTools unless `RC_DEVTOOLS=1` is set (the download from the Chrome Web Store retries 5× and takes ~60s when the network is restricted).
- **Debug**: `pnpm debug` — attach via `chrome://inspect` on port 9222
- **Typecheck**: `pnpm typecheck` — concurrent `tsgo` node + web checks
- **Full Build**: `pnpm build` — typecheck + electron-vite build
- **Build Check**: `pnpm build:check` — `pnpm lint && pnpm test`
- **Test**: `pnpm test` (all) / `test:main` / `test:renderer` / `test:shared` / `test:scripts` / `test:e2e` (Playwright)
- **Lint**: `pnpm lint` — oxlint + eslint + typecheck + i18n check + format
- **Format**: `pnpm format` — Biome write mode
- **i18n**: `pnpm i18n:check` (validate) / `pnpm i18n:sync` (sync + sort keys)
- **Bundle Analysis**: `pnpm analyze:renderer` / `pnpm analyze:main`
- **Release packaging**: `pnpm build:win:x64 --publish never`, `build:mac* --publish never`, `build:linux* --publish never`, `release` (see `electron-builder.yml`). **`--publish never` is not optional here:** `$env:CI='true'` (which every command in this project sets, to dodge pnpm's TTY abort) makes electron-builder treat the run as CI and **implicitly attempt a GitHub Release publish** — which then fails with a missing `GH_TOKEN`, turning a *successful* packaging run into `exit 1`. That has already been misread as "the build failed" once. electron-builder warns this implicit behaviour is removed in v27. **Read the tail of a build log before concluding anything about the build: if the artifacts exist and are signed, packaging succeeded and only the publish step failed.**

## Project Architecture

### Electron Structure

```
src/
  main/          # Node.js backend (Electron main process) — contains the dsh kernel (src/main/kernel)
  renderer/      # React UI (Electron renderer process)
  preload/       # Secure IPC bridge (contextBridge)
packages/
  shared/        # Cross-process types, constants, IPC channel definitions, small utils
  mcp-trace/     # OpenTelemetry trace-core + node/web adapters (name is historical; actively used)
```

### Key Path Aliases

| Alias | Resolves To |
|---|---|
| `@main` | `src/main/` |
| `@renderer` | `src/renderer/src/` |
| `@shared` | `packages/shared/` |
| `@types` | `src/renderer/src/types/` |
| `@logger` | `src/main/services/LoggerService` (main) / `src/renderer/src/services/LoggerService` (renderer) |
| `@mcp-trace/trace-core` | `packages/mcp-trace/trace-core/` |
| `@mcp-trace/trace-node` / `@mcp-trace/trace-web` | `packages/mcp-trace/trace-node/` / `packages/mcp-trace/trace-web/` |

### Main Process (`src/main/`)

Entry: `index.ts` (app lifecycle) → `bootstrap.ts` → `kernel/index.ts` (kernel boot) + `ipc.ts` (all IPC handlers).
`electron.vite.config.ts` externalizes **all** `dependencies`, so anything the main process `require`s at runtime must stay in `dependencies` (removing one breaks only at runtime, never at build time — verify with grep before touching `package.json`).

Main services (`src/main/services/`) — actual set:

| Service | Responsibility |
|---|---|
| `WindowService` | Window lifecycle (main / mini / trace windows), tray integration |
| `LoggerService` | Winston structured logging with daily rotation |
| `ProviderKeyStore` | Encrypted provider API keys (electron-store + `safeStorage`) |
| `BackupManager` | Local / WebDAV / Nutstore backup & restore |
| `FileStorage` / `FileSystemService` | File storage, PDF/text extraction helpers, ripgrep search |
| `ConfigManager` / `StoreSyncService` | Main-process config store; Redux store sync |
| `ShortcutService` / `TrayService` / `AppMenuService` / `ContextMenu` | Input & shell integration |
| `ThemeService` / `WebviewService` / `SearchService` / `ProtocolClient` | Theme, miniapp webviews, search window, URL schemes |
| `ExportService` / `AnalyticsService` / `VersionService` / `AppService` / `NotificationService` | Export, opt-in analytics, version info, misc app APIs |
| `NodeTraceService` / `SpanCacheService` | OpenTelemetry export + trace viewer cache |
| `memory/MemoryService` | Local memory subsystem |
| `proxy/`, `urlschema/` | Proxy bootstrap (separate build entry) and URL-scheme handlers |

### dsh Kernel (`src/main/kernel/`)

The dsh kernel is embedded in-process as a Cordis plugin tree (never via the YAML loader):

| File | Responsibility |
|---|---|
| `index.ts` | Programmatic plugin assembly (settings-file + credentials + llm + pi-ai adapter + system prompt + tools + session store/SQLite persistence + agent registry/loop) and all `dsh:*` IPC. The dsh session-title plugin was removed in v0.3.1 — topic auto-naming runs in the renderer (`services/topicNaming.ts`, V1 semantics via the quick model) and reaches the kernel registry through `Dsh_TopicRename` only |
| `topics.ts` | Topic registry & chat operations; topic = dsh session + agent; `destroyTurns` deletion engine; reasoning-level convergence |
| `providers.ts` | Renderer provider config → pi-ai routes (`KernelProviderInput`); clears stale routes on resync |
| `credentials.ts` | In-memory credential provider (`CherryCredentialProvider`), multi-key rotation per request |
| `services.ts` | App service seams: `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning` (plugins may take over); `ctx.topicTree.uiEvents` returns the UI view of a session log |
| `sessionEventView.ts` | The single injected-event predicate plus the UI view of session events (v0.3.0-1). All three UI exits apply it: live broadcast, `uiEvents` IPC, `searchSessions` — the renderer holds no visibility predicate of its own |
| `dsmlRepair.ts` | Response-side DSML tool-call repair, registered as an `llm/stream` waterfall middleware — replaced the `@deepseek-ai/dsh-llm-pi-ai` pnpm patch in v0.3.0-1 |
| `thinkingReplay.ts` | Request-side prior-turn thinking replay trim (v0.3.1), installed as a `globalThis` neutral gate consumed by the one-line `dsh-llm-pi-ai` patch; intra-turn thinking kept, prior turns stripped on the wire, DB untouched |
| `sessionResumeFallback.ts` | The **single** decision point for "resume failed — refuse or create fresh" (v0.3.0-2). The criterion is a **persistence existence query** (`ctx.sessionPersistence.list()`), never the error's type; fail-closed when the query itself fails, and `createFresh()` is only reachable after the session is confirmed absent |
| `sessionReadFailure.ts` | Diagnostic classification of a read failure (`format-unsupported` / `corrupted` / `unclassified`) for logging only (v0.3.0-2). **Its return value must never gate session creation** — the security criterion lives in `sessionResumeFallback.ts` |

Renderer side: `src/renderer/src/services/kernelChat.ts` subscribes to kernel `session/event` and projects messages/blocks into Redux. The **quick assistant** (mini window) is the one deliberately separate path: it calls `window.api.dshStreamComplete` without a kernel session.

### Renderer Process (`src/renderer/src/`)

React 19 + Redux Toolkit SPA. Routes (`Router.tsx`): `/` (home), `/files`, `/settings/*`. The directory layout under this path is the filesystem's to state — `src/renderer/src/` holds `components/`, `databases/` (Dexie: files / settings / knowledge_notes / quick_phrases), `hooks/`, `pages/`, `services/`, `store/`, `types/`, `workers/` (pyodide, shiki-stream) and `windows/` (the mini window entry).

### Redux Store (`src/renderer/src/store/`)

The authoritative list of slices is the `combineReducers` call in `src/renderer/src/store/index.ts` — read it there rather than trusting any list, including this one. Two things it will not tell you by shape: two state keys are **not** named after their file (`messages` ← `newMessagesReducer` in `newMessage.ts`, `messageBlocks` ← `messageBlocksReducer` in `messageBlock.ts`), and `userQuestions.ts` is a real registered slice that no earlier inventory in this file mentioned. Persist config lives in `index.ts`; migrations in `migrate.ts`.

- `migrate.ts` holds the `{'2': fn, ..., '<N>': fn}` migration table. **Every branch is reachable** (redux-persist runs all keys with `currentVersion >= key > inboundVersion`), and a throw inside a branch discards the entire persisted state. Do not delete migration branches; when adding a branch, bump `version` in `index.ts` and the highest key in `migrate.ts` together — **the current `version` is in `index.ts`, not in this file, because numbers written here go stale** (an earlier revision of this file said 213 while the code was already at 214).
- `blacklist` in the persist config means "not written to localStorage", **not** "unused".

### Database Layer

- **IndexedDB (Dexie)**: `src/renderer/src/databases/index.ts` — `files`, `settings`, `knowledge_notes`, `quick_phrases`. Older tables (`topics`, `message_blocks`, `translate_*`) are dropped in later schema versions because chat data moved into the kernel's SQLite.
- **Kernel SQLite**: `{userData}/kernel/sessions.db` (session event log) + `{userData}/kernel/settings.json` (pi-ai routes). Provider keys live in `{userData}/provider-keys.json` (encrypted).

### IPC Communication

- Channel constants: `packages/shared/IpcChannel.ts`; handlers: `src/main/ipc.ts` (+ `kernel/index.ts` for `dsh:*`); bridge: `src/preload/index.ts` exposing `window.api`.
- Renderer → Main: `ipcRenderer.invoke(IpcChannel.XXX, ...args)`; Main → Renderer: `webContents.send(channel, data)`.
- When adding/removing a channel, update **all three** layers (constant, handler, preload) and grep for both the enum name and the string literal.

### Multi-Window Architecture

- `index.html` — main window
- `miniWindow.html` — quick assistant (`windows/mini/`)
- `traceWindow.html` — OpenTelemetry trace viewer (`trace/`)

### Logging

```typescript
import { loggerService } from '@logger'
const logger = loggerService.withContext('moduleName')
// Renderer only: loggerService.initWindowSource('windowName') first
logger.info('message', CONTEXT)
logger.warn('message')
logger.error('message', error)
```

Winston with daily rotation; log files in `userData/logs/`. Never use `console.log`.

### Tracing (OpenTelemetry) — alive, do not remove

`packages/mcp-trace/` (trace-core / trace-node / trace-web) + `NodeTraceService` + `SpanCacheService` + the trace window are wired to `enableDeveloperMode`. The package name is historical; the tracing subsystem is a live feature.

## Tech Stack

| Layer | Technologies |
|---|---|
| Runtime | Electron 41, Node ≥24.11.1, pnpm 10.27.0 |
| Frontend | React 19, TypeScript ~5.8 |
| UI | Ant Design 5.27, styled-components 6, TailwindCSS v4 |
| State | Redux Toolkit 2, redux-persist 6, Dexie 4 (IndexedDB) |
| Rich Text | — (TipTap / RichEditor 已整体移除；`packages/extension-table-plus` 同批删除) |
| AI Kernel | dsh (DeepSeek Harness) `@deepseek-ai/dsh-*` 0.1.1-rc.2 + `@deepseek-ai/cordis` 4 |
| Build | electron-vite 5 with rolldown-vite 7 |
| Test | Vitest 3 (unit), Playwright (e2e) |
| Lint/Format | ESLint 9, oxlint, Biome 2 |
| Logging / Tracing | Winston + daily-rotate / OpenTelemetry |
| i18n | i18next + react-i18next (**zh-CN and en-US only**) |

## Conventions

### TypeScript

- Strict mode; typecheck with `tsgo` (`tsconfig.node.json` for main, `tsconfig.web.json` for renderer).
- Types live in `src/renderer/src/types/` and `packages/shared/`.

### Code Style

- Biome formats (2-space indent, single quotes, trailing commas); oxlint + ESLint lint (with `simple-import-sort`, `react-hooks`, `unused-imports`).

### File Naming

- React components: `PascalCase.tsx`; services/hooks/utils: `camelCase.ts`; tests: `*.test.ts(x)` next to source or in `__tests__/`.

### i18n

- All user-visible strings go through `i18next` — never hardcode UI strings.
- Only `src/renderer/src/i18n/locales/{zh-cn,en-us}.json` exist; the machine-translated `translate/` directory and the auto-translate pipeline were removed in v0.2.4-1. Adding a language means re-adding the file, the `i18n/index.ts` import, the `LanguageVarious` union, the antd locale case, the general-settings option, and the emoji-picker maps.
- `pnpm i18n:check` validates key parity; `pnpm i18n:sync` syncs + sorts keys.

### pnpm Configuration & Patches

pnpm settings live in **`pnpm-workspace.yaml`**, not in a `pnpm` field of `package.json`: pnpm 10.6+ ignores that field (it only prints a warning) and pnpm 11 stops reading it entirely. The keys `overrides`, `patchedDependencies` and `onlyBuiltDependencies` are declared there. Moving any of them back into `package.json` silently disables them as soon as the lockfile is regenerated — the `overrides` include several security pins and the patches are load-bearing (libsql's affects win32-arm64 native resolution, file-stream-rotator's affects log rotation, antd's replaces an icon import).

`patches/` must stay in 1:1 correspondence with `patchedDependencies`. Current patches (6): `antd@5.27.0`, `atomically@1.7.0`, `file-stream-rotator@0.6.1`, `libsql@0.4.7`, `node-pty@1.2.0-beta.15`, `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` (**neutral gate only** — see the request-side thinking trim below).

Why the three non-trivial patches exist — the rule is the first sentence; the full incident records are in the version reports:

- **`node-pty@1.2.0-beta.15`** — its `binding.gyp` hard-codes `SpectreMitigation: 'Spectre'` on the `OS=="win"` branch, which needs Spectre-mitigated CRT libs a plain VS BuildTools install lacks (MSB8040). The patch removes that block only; the `/guard:cf` `/sdl` `/DYNAMICBASE` hardening stays. Transitive dep of `@deepseek-ai/dsh-subprocess-local`, so it is patched rather than the kernel package. Record: `<workspace>/docs/v0.3.0_doc.md` §8.9.
- **DSML response-side repair is no longer a patch (v0.3.0-1)** — it lives in **our own** module `src/main/kernel/dsmlRepair.ts`, registered via `registerDsmlRepair` on the dsh-documented **`llm/stream` waterfall** that both agent-loop call paths pass through. Semantics unchanged (well-formed marker + valid JSON → real tool-call; malformed → passthrough, fail-safe), pinned by `__tests__/dsmlRepair.test.ts`. Record: `<workspace>/docs/v0.3.0-1_doc.md`.
- **`@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2` neutral gate (v0.3.1)** — one line at the top of `streamWithSnapshot`: `options = globalThis.__recTrimPriorTurnThinking?.(options) ?? options`. Request-side thinking replay trim cannot be reached from any public seam, so the patch is a bare hook with **zero fork semantics** — with the hook absent the package equals upstream. All logic is in `src/main/kernel/thinkingReplay.ts`. Record: `<workspace>/docs/v0.3.1_doc.md`.

**On any kernel-package upgrade, re-run both of these and nothing else:** `__tests__/dsmlRepair.test.ts` + one real-machine session (DSML), and `__tests__/thinkingReplay.test.ts` + `tools/branch-jump-artifacts/probe-e2e-thinking-trim.js` (thinking trim).

## Testing Guidelines

- Vitest 3 with project-based configs; main tests run in Node (`tests/main.setup.ts`), renderer tests in jsdom (`tests/renderer.setup.ts`, `@testing-library/react`).
- Coverage via v8 (`pnpm test:coverage`); e2e via Playwright (`tests/e2e/`).
- A module whose only reference is its own `__tests__` file is dead code — prefer deleting module + test together over keeping tests for unreachable code. A *single export* inside an active module that is only referenced by its own test is **not** dead code — keep it.
- **A new gate or guard is not proven until a reverse-control probe turned it red.** Plant a deliberate break, watch the specific check fail by name, then remove the probe and confirm the suite is green again with a clean `git diff`. A guard whose failure mode is silent (retry logic that always burns its full window, a sweep guard that would delete the library) can only be trusted after this.
- **"Green" always needs its scope stated.** `pnpm lint` does not run tests; the nine static checks cover references/syntax/config/i18n but **not** types; a single sample cannot prove an intermittent failure is gone. Name the four greens and their boundaries in every acceptance record instead of writing "all green". The four are: typecheck, lint's full chain, the static-check suite, and the build — **and the first two need pnpm, i.e. the user's real machine or an explicit permission grant.**

## Project Lessons

`<workspace>/docs/经验教训.md` collects the binding lessons, judgement rules, rejected approaches and open debts that were distilled from the version reports. Read it when deciding whether something may be deleted, whether a failure counts as "empty", or whether a green signal is strong enough to conclude from. The per-version reports in `<workspace>/docs/` remain the detailed record — go to the specific version when you need its evidence.

## Important Notes

### Security

- Never expose Node.js APIs directly to the renderer; use `contextBridge` in preload.
- Validate all IPC inputs in the main-process handlers.
- Provider API keys: persisted encrypted via `ProviderKeyStore`; a redux-persist transform strips non-empty `apiKey` from localStorage.

### Deprecation Headers

Some files still carry the upstream `⚠️ NOTICE: V2 DATA&UI REFACTORING` / `@deprecated Scheduled for removal in v2.0.0` header. Those headers refer to **upstream Cherry Studio's** v2 refactor and are not authoritative here. Treat them as ordinary code; the fork's own roadmap (`docs/当前任务总体规划.txt` in the workspace) decides what is deprecated.
