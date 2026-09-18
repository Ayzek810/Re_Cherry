# AI Assistant Guide

> **Re_Cherry** is a personal fork of Cherry Studio v1.9.11, heavily trimmed, with the chat/agent message path unified onto an in-process **DSH (DeepSeek Harness) Cordis kernel**. Most upstream Cherry Studio documentation (agent pages, MCP, knowledge base, apiServer, updater, Copilot, Pyodide, OVMS, selection toolbar, Drizzle agents DB) **no longer applies** — those subsystems have been removed. When in doubt, read the code, not this file's history.
>
> **Layer contract** — this file carries only what every request needs: conduct, environment facts, hard invariants as one-liners, and navigation. Rules (判据, with their triggers) live in `docs/经验教训.md`, cited as `§N.M`; evidence lives in `docs/archive/`; outstanding debts in `docs/未清债.md`. A rule that is not needed on *every* request does not belong here.

## Guiding Principles

- **Keep it clear**: write code that is easy to read, maintain, and explain.
- **Match the house style**: reuse existing patterns, naming, and conventions.
- **Search smart**: `grep`/`glob`/`read`, semantic queries over guesswork — scoped per *Loop Discipline*.
- **Confirm before acting — but only where confirmation means something.** A direct instruction from the user **is** the authorisation: do the thing, then report. Do not re-derive "may I?" from the instruction you were just given, and do not ask twice for the same decision. Reserve the ask for what nobody asked for and cannot be undone: rewriting history, force-pushing, deleting data or files, or a structural change to how this project works.
- **Never commit**: finish the work and hand it over for acceptance — no `git commit` / `git add` / `git push`.
- **Write the version report** — decisions and evidence only, not process. Rules: every version/phase ends with `<workspace>/docs/[version]_doc.md`; once published it moves to `docs/archive/` and is never edited again; `docs/` root holds **no** version report between releases; acceptance-repair fixes fold into *that version's* report as a new dated section; sub-releases (`-1`, `.1`) nest inside the parent file, never a separate one. Template, size cap (~40 KB / 500 lines) and nesting mechanics are defined in `docs/README.md`. Distil anything still binding into `docs/经验教训.md`.
- **No pointer-style instruction files**: a sibling file is loaded *in addition to*, never instead of, its target, and `dsh-agent-instructions` collapses siblings only when byte-identical (`dedupInstructionFilesByDirectory`) — a pointer file doubles the fixed per-request cost. Read `docs/README.md` before adding or moving anything under `docs/`.
- **No blind deletion**: prove code unreferenced via the static-check suite first, scoped grep only as fallback (both under *Environment & Sandbox*). This fork's single biggest regression risk is deleting something that is still wired up.

## Environment & Sandbox (IMPORTANT)

Sandbox permissions depend on what the session was granted. When the gates are available, **run them for real instead of reasoning about them**. Two environment facts:

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node ≥24.11.1; DSH's bundled Node 24.9.0 is too old
$env:CI = "true"                        # avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

**`pnpm` does not run under the sandbox.** The wrapper spawns a child process, so every `pnpm <script>` dies with `Error: spawn EPERM` (`pnpm-runner.mjs`) — deterministically, not intermittently. Do not keep retrying it or working around it by hand. When a step genuinely needs pnpm, ask the user to grant full permissions for **that command**, naming it and the why. Everything reachable without pnpm must be reached that way: `node_modules/.bin/` holds `tsgo`, `vitest`, `oxlint`, `eslint`, `biome`, `playwright` and `electron-vite`, so read the pnpm script in `package.json` and invoke the same binary directly (typecheck = `tsgo --noEmit -p tsconfig.node.json` + `... -p tsconfig.web.json`). When the gates are **not** available, say so explicitly rather than claiming a run; the static-check suite below is the fallback (it needs no `node_modules`), and only then scoped code review — the grep-consumption-forms and cross-validation discipline for that is `§2.7` / `§2.8`.

**The shell is Windows PowerShell 5.1, and its signals are treacherous** (one rewrite died on this): `Get-Content` decodes ANSI; `>` / `Out-File` default to UTF-16LE; pipeline exit codes can differ from the real one. Read files with file tools or `[System.IO.File]::ReadAllText`, write with an explicit UTF-8 no-BOM encoder, and trust only `$LASTEXITCODE`. Full trap list: `§4.9`.

**Static-check suite** — ten checks, lives outside the repo:

```powershell
node E:\Workspace\project_REC\tools\static-checks\run-all.js
```

All ten must be green (exit 0) after any batch of deletions/renames. `check-upstream` self-skips without the upstream tree at `E:\Workspace\project_REC\参考资产\cherry-studio v1.9.11`. The ten: imports · symbols · syntax (`.ts` only) · configs (incl. `patches/` ↔ `patchedDependencies` 1:1) · i18n-parity · main-i18n · i18n-keys (baseline-based) · i18n-dynamic · upstream · package-runtime-closure（根 package.json 沿正则边收集的闭包必须覆盖每个包 dep+peer 的运行期边——运行期要用的纯 peer 包必须在根 dependencies 显式声明；0.3.1-1 安装包崩溃事故，判据 `§4.16`）. **Coverage gaps, false positives and usage discipline live in `tools/static-checks/README.md` — read it before acting on a report.** The i18n checks exist because text can be consumed in six forms without ever appearing as a literal (the main process reads locale keys by *object value* — `'tray.show_window'` appears nowhere): never prune i18n keys, barrels or side-effect imports without enumerating them (`§2.7`). The suite catches broken references, syntax and config breakage, **not** type errors — when deleting a field/type, grep every consumer including `store/migrate.ts`, and delete the dead statements rather than adding `@ts-expect-error` (`§4.2`).

## Hard Invariants (one line each; 判据 in `docs/经验教训.md`)

| # | Invariant | 判据 |
|---|---|---|
| 1 | Kernel-plugin compatibility contract is a hard acceptance gate: never bypass the cordis `ctx.plugin` lifecycle or public seams (`ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`, `ToolRuntime`, `session/event`); IPC handlers are thin forwarders; no direct SQLite outside the kernel | `docs/内核插件兼容契约.md`, §3.19 |
| 2 | The kernel session log is the single source of truth; the renderer is a projection — every conversational state must be recoverable by folding it; no parallel sources of truth | §3.1 |
| 3 | Topic membership is the kernel's to decide, never the renderer's (`dshTopicList` is authoritative; only rows restored from the previous session may be judged stale; pinned by `services/__tests__/topicAuthorityGate.test.ts`) | §3.2 |
| 4 | `ensureAgent` may never silently create a session over an existing log — `sessionResumeFallback.ts` is the single decision point (persistence existence query, fail-closed); the error's *type* is diagnostic only | §1.4/§1.5 |
| 5 | Every kernel query must tolerate the boot window (window creation and kernel boot run in parallel) via `retryKernelQuery`; a definitive answer — including a negative one — returns immediately; `null` means "no answer" and never justifies refusing or hiding | §3.4, §2.1 |
| 6 | An unknowable state never authorises a destructive action: registry `failed` ≠ `absent`, the sweep is skipped entirely, and the unreadable registry is backed up before anything can overwrite it. Same shape everywhere: never treat "no answer" as "empty" | §1.1–§1.3 |
| 7 | The renderer holds no event-visibility predicate — `sessionEventView.ts` is the only one, applied at all three UI exits (live broadcast, `uiEvents`, search) | §2.4 |
| 8 | Startup order is a safety property (`src/main/index.ts`): `registerShortcuts()` and `await registerIpc()` stay ahead of every cosmetic/optional initializer, and those stay wrapped in log-only `try/catch` — a cosmetic failure must never cost basic usability | — |
| 9 | Kernel-package intrusion only where a public seam cannot reach it, and then only as a one-line `globalThis` **neutral gate** (gate absent = upstream-identical logic, all logic fork-side); response-side changes go through the documented `llm/stream` waterfall | §3.5, §3.6 |
| 10 | Tracing is alive: `packages/mcp-trace/` + `NodeTraceService` + `SpanCacheService` + the trace window are a live feature (name is historical) | §5.9 |

## Loop Discipline (cost control)

- **A logic hunt needs a stop condition.** Words like "彻查" / "深入排查" have no endpoint, and an unbounded one is the single most expensive thing this project does — one past session ran 2,613 steps / 526 minutes / 1.8 亿 input tokens against 19 steps for a normal task. If the last several steps produced no new hypothesis or no new evidence, **stop and report**: what you ruled out, what remains, what you would try next.
- **Explore in a subagent, decide in the main session.** Bulk reading, multi-file surveys and parallel extraction belong in a subagent; the main session receives conclusions. A subagent redistributes cost, it does not reduce it.
- **Batch, don't repeat.** About to do the same kind of operation a third time → switch to a script, one batched command, or one scoped query.
- **Edit an injected instruction file in one pass.** Every `write`/`edit` to `CLAUDE.md` (or any `AGENTS.md`) re-injects the whole file into the next request — think the change through and land it in one edit.
- **Prefer the gate over the hand audit.** One real type gate (`tsgo` direct, not via a pnpm script in the sandbox) is cheaper and stronger than grepping the tree by hand; grep only for what no gate answers.
- **Retrieval must be scoped.** `glob`/`grep` pass `--no-ignore` and exclude only VCS metadata, so `node_modules`, `dist`, `out` and vendored trees **are** searched and `.gitignore` is not honoured. Measured: a bare `**/*.ts` from this repo's root returns **33,094** paths and shows the wrong 100 (all `node_modules`); scoped to `src/` it returns **458**. Always pass `path`, pick the narrowest root, never search from the repo or workspace root.
- **Never search `参考资产/` on your own initiative.** ~170k files / 2.5 GB (upstream trees plus their `node_modules`), 71% of every `.md` in the workspace. Exceptions only: (a) the user explicitly asks for an upstream comparison — then delegate to a subagent, name one subdirectory, require scoped searches, and require **conclusions only**; (b) `check-upstream.js` reading it as a machine gate.

## Development Commands (run on the user's real machine)

- **Install**: `pnpm install` — Node ≥24.11.1, pnpm 10.27.0
- **Dev**: `pnpm dev` (port 5870 / `DSH_DEV_PORT`; EACCES → `netsh interface ipv4 show excludedportrange protocol=tcp`; React/Redux DevTools only with `RC_DEVTOOLS=1`)
- **Debug**: `pnpm debug` — `chrome://inspect` on port 9222
- **Typecheck**: `pnpm typecheck` · **Build**: `pnpm build` · **Build check**: `pnpm build:check` (`lint && test`) · **Test**: `pnpm test` / `test:main` / `test:renderer` / `test:shared` / `test:scripts` / `test:e2e`
- **Lint**: `pnpm lint` · **Format**: `pnpm format` · **i18n**: `pnpm i18n:check` / `i18n:sync` · **Analyze**: `pnpm analyze:renderer` / `analyze:main`
- **Packaging**: `pnpm build:win:x64 --publish never` (likewise `build:mac*` / `build:linux*`). **`--publish never` is not optional**: `$env:CI='true'` makes electron-builder treat the run as CI and implicitly attempt a GitHub Release publish, which fails on missing `GH_TOKEN` and turns a *successful* packaging into `exit 1`. Read the tail of a build log before concluding anything: artifacts present and signed ⇒ packaging succeeded, only the publish step failed.

## Project Architecture

### Structure & Aliases

```
src/
  main/          # Electron main process — hosts the dsh kernel (src/main/kernel)
  renderer/      # React SPA (src/renderer/src: components/ databases/ hooks/ pages/ services/ store/ types/ workers/ windows/)
  preload/       # contextBridge IPC → window.api
packages/
  shared/        # cross-process types, constants, IPC channel definitions, small utils
  mcp-trace/     # OpenTelemetry trace-core + node/web adapters (name is historical; LIVE)
```

Entry: `src/main/index.ts` (app lifecycle) → `bootstrap.ts` → `kernel/index.ts` (kernel boot) + `ipc.ts` (IPC handlers). Windows: `index.html` (main) · `miniWindow.html` (quick assistant, `windows/mini/`) · `traceWindow.html` (trace viewer).

| Alias | Resolves To |
|---|---|
| `@main` | `src/main/` |
| `@renderer` | `src/renderer/src/` |
| `@shared` | `packages/shared/` |
| `@types` | `src/renderer/src/types/` |
| `@logger` | `src/main/services/LoggerService` (main) / `src/renderer/src/services/LoggerService` (renderer) |
| `@mcp-trace/*` | `packages/mcp-trace/{trace-core,trace-node,trace-web}/` |

**Main services**: the authoritative set is the directory `src/main/services/` itself; all are live fork services. Non-obvious ones: `ProviderKeyStore` (encrypted API keys), `StoreSyncService` (Redux sync), `BackupManager` (local/WebDAV/Nutstore), `FileSystemService` (incl. ripgrep search).

**`electron.vite.config.ts` externalizes *all* `dependencies`** — anything the main process `require`s at runtime must stay in `dependencies`; removing one breaks at runtime, never at build time (grep before touching `package.json`). Its packaging twin: pnpm satisfies peer-only packages inside `.pnpm` so dev stays green, but the shipped closure follows regular edges from the root manifest — a runtime-needed peer-only package must **also** be root-declared (`§4.16`; v0.3.1-1 installed-build `ERR_MODULE_NOT_FOUND` crash).

### dsh Kernel (`src/main/kernel/`)

Embedded in-process as a Cordis plugin tree, never via the YAML loader:

| File | Responsibility |
|---|---|
| `index.ts` | Programmatic plugin assembly (settings-file, credentials, llm, pi-ai adapter, system prompt, tools, session store + SQLite persistence, agent registry/loop) and all `dsh:*` IPC. Topic auto-naming runs renderer-side (`services/topicNaming.ts`) and reaches the registry only via `Dsh_TopicRename` |
| `topics.ts` | Topic registry & chat ops (topic = dsh session + agent), `destroyTurns` deletion engine, reasoning-level convergence |
| `providers.ts` | Renderer provider config → pi-ai routes (`KernelProviderInput`); clears stale routes on resync |
| `credentials.ts` | In-memory credential provider (`CherryCredentialProvider`), multi-key rotation per request |
| `services.ts` | App service seams: `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning`; structural operations go through them; `topicTree.uiEvents` = UI view of a session log |
| `sessionEventView.ts` | The single injected-event predicate + UI view of session events (invariant 7) |
| `dsmlRepair.ts` | Response-side DSML tool-call repair as an `llm/stream` waterfall middleware (replaced the old pnpm patch) |
| `thinkingReplay.ts` | Request-side prior-turn thinking trim behind the one-line neutral gate (invariant 9): intra-turn thinking kept, prior turns stripped on the wire, DB untouched |
| `sessionResumeFallback.ts` | The single refuse-vs-create decision point (invariant 4) |
| `sessionReadFailure.ts` | Read-failure classification, **logging only** — its return value must never gate session creation |

Renderer side: `services/kernelChat.ts` subscribes to kernel `session/event` and projects into Redux (not to be confused with the legacy `services/messageStreaming/**` layer). The **quick assistant** (mini window) is the one deliberately separate path: `window.api.dshStreamComplete` without a kernel session.

### Renderer, Redux, Data

- **Redux**: the authoritative slice list is the `combineReducers` call in `src/renderer/src/store/index.ts` — read it there. Two state keys are not named after their files: `messages` ← `newMessage.ts`, `messageBlocks` ← `messageBlock.ts`.
- **Migrations** (`store/migrate.ts`): every branch is reachable (redux-persist runs all keys `currentVersion >= key > inboundVersion`); a throw inside a branch discards the whole persisted state. Never delete branches; adding one means bumping `version` in `index.ts` and the highest key in `migrate.ts` together — the current `version` lives in `index.ts`, not here. `blacklist` in the persist config means "not written to localStorage", **not** "unused".
- **IndexedDB (Dexie)**, `src/renderer/src/databases/index.ts`: `files`, `settings`, `knowledge_notes`, `quick_phrases`. Old chat tables are dropped in later schema versions — chat data lives in kernel SQLite (`{userData}/kernel/sessions.db` session event log; `{userData}/kernel/settings.json` pi-ai routes). Provider keys: `{userData}/provider-keys.json` (encrypted).

### IPC

Channel constants in `packages/shared/IpcChannel.ts`; handlers in `src/main/ipc.ts` + `kernel/index.ts` (`dsh:*`); bridge in `src/preload/index.ts` (`window.api`). Adding/removing a channel updates **all three** layers; grep both the enum name and the string literal.

### Logging

```typescript
import { loggerService } from '@logger'
const logger = loggerService.withContext('moduleName') // renderer: initWindowSource('windowName') once
logger.info('message', CONTEXT) / logger.warn(...) / logger.error('message', error)
```

Winston with daily rotation, files in `userData/logs/`. Never `console.log`.

## Tech Stack

| Layer | Technologies |
|---|---|
| Runtime | Electron 41, Node ≥24.11.1, pnpm 10.27.0 |
| Frontend | React 19, TypeScript ~5.8 |
| UI | Ant Design 5.27, styled-components 6, TailwindCSS v4 |
| State | Redux Toolkit 2, redux-persist 6, Dexie 4 (IndexedDB) |
| Rich Text | none (TipTap / RichEditor / `extension-table-plus` removed with the editor) |
| AI Kernel | dsh `@deepseek-ai/dsh-*` 0.1.1-rc.2 + `@deepseek-ai/cordis` 4 |
| Build / Test | electron-vite 5 + rolldown-vite 7 · Vitest 3 · Playwright · ESLint 9 + oxlint + Biome 2 |
| Logging / Tracing | Winston + daily-rotate / OpenTelemetry |
| i18n | i18next + react-i18next (**zh-CN and en-US only**) |

## Conventions

- **TypeScript**: strict; `tsgo` typecheck (`tsconfig.node.json` main, `tsconfig.web.json` renderer). Types live in `src/renderer/src/types/` and `packages/shared/`.
- **Style**: Biome (2-space, single quotes, trailing commas); oxlint + ESLint (`simple-import-sort`, `react-hooks`, `unused-imports`).
- **Naming**: components `PascalCase.tsx`; services/hooks/utils `camelCase.ts`; tests `*.test.ts(x)` beside source or in `__tests__/`.
- **i18n**: all user-visible strings through `i18next`, never hardcoded. Adding a language means re-adding the locale file, the `i18n/index.ts` import, the `LanguageVarious` union, the antd locale case, the general-settings option, and the emoji-picker maps.
- **pnpm config lives in `pnpm-workspace.yaml`, not a `pnpm` field of `package.json`** — pnpm 10.6+ ignores that field, pnpm 11 stops reading it. `overrides` (security pins), `patchedDependencies` and `onlyBuiltDependencies` live there; moving them back silently disables them at the next lockfile regen.
- **Patches** (`patches/` ↔ `patchedDependencies` 1:1, currently 6): `antd` (icon import) · `atomically` · `file-stream-rotator` (log rotation) · `libsql` (win32-arm64 native resolution) · `node-pty` (drops the `SpectreMitigation` block that demands MSB8040 libs; transitive dep — `§5.5`) · `@deepseek-ai/dsh-llm-pi-ai` (**one-line neutral gate only**, zero fork semantics — invariant 9). **On any kernel-package upgrade, re-run these and nothing else:** `__tests__/dsmlRepair.test.ts` + one real DSML session; `__tests__/thinkingReplay.test.ts` + `tools/branch-jump-artifacts/probe-e2e-thinking-trim.js` (`§4.14`).

## Testing

- Vitest 3 project configs: main in Node (`tests/main.setup.ts`), renderer in jsdom (`tests/renderer.setup.ts`, `@testing-library/react`); coverage v8; e2e in Playwright (`tests/e2e/`).
- A module whose **only** reference is its own `__tests__` file is dead code — delete module + test together. A *single export* in an active module referenced only by its own test is **not** dead (`§5.10`).
- A new gate or guard is not proven until a **reverse-control probe turned it red**: plant a deliberate break, watch the specific check fail by name, remove the probe, confirm green with a clean `git diff` (`§4.3`).
- **State each green's scope** (`§4.1`/`§4.2`): the four greens are typecheck, lint's full chain, the static-check suite, and the build — `pnpm lint` runs no tests, the static suite covers references/syntax/config/i18n but **not** types, and the first two need pnpm (real machine or explicit grant).

## Workspace Docs — what to read

| File | Read when |
|---|---|
| `docs/经验教训.md` | before/after any judgment call — the rules home this file's `§` pointers cite |
| `docs/项目介绍及总规划.txt` | scope verdicts, roadmap, how work is versioned |
| `docs/内核插件兼容契约.md` | before any touch of `src/main/kernel/` |
| `docs/未清债.md` | before touching a debt area, before citing "known issues" |
| `docs/README.md` | navigation, report template, writing discipline |

**`docs/archive/` is archaeology, not orientation** — enter only with a specific question ("which incident produced this constraint"), grep it, never read it through. Trap: `archive/v0.3.1_doc.md` is a *merged* file whose `v0.3.2/3/4` labels are batch names inside the v0.3.1 cycle, not versions that happened.

## Security & Upstream Legacy

- Never expose Node.js APIs directly to the renderer — `contextBridge` in preload; validate all IPC inputs in main handlers.
- Provider API keys: encrypted at rest via `ProviderKeyStore`; a redux-persist transform strips non-empty `apiKey` from localStorage (`§1.6`).
- Upstream `⚠️ NOTICE: V2 DATA&UI REFACTORING` / `@deprecated` headers refer to **upstream**'s v2 refactor; treat them as ordinary code — the fork roadmap decides (`§5.11`).
