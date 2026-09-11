# AI Assistant Guide

This file provides guidance to AI coding assistants when working with code in this repository. Adherence to these guidelines is crucial for maintaining code quality and consistency.

> **Re_Cherry** is a personal fork of Cherry Studio v1.9.11, heavily trimmed, with the chat/agent message path unified onto an in-process **DSH (DeepSeek Harness) Cordis kernel**. Most upstream Cherry Studio documentation (agent pages, MCP, knowledge base, apiServer, updater, Copilot, Pyodide, OVMS, selection toolbar, Drizzle agents DB) **no longer applies** — those subsystems have been removed. When in doubt, read the code, not this file's history.

## Guiding Principles (MUST FOLLOW)

- **Keep it clear**: Write code that is easy to read, maintain, and explain.
- **Match the house style**: Reuse existing patterns, naming, and conventions.
- **Search smart**: Use the `grep`/`glob`/`read` tools; prefer semantic queries over guesswork.
- **Log centrally**: Route all logging through `loggerService` with the right context—no `console.log`.
- **Always propose before executing**: Before making any changes, clearly explain your planned approach and wait for explicit user approval.
- **Never commit**: Finish your work and hand it to the user for acceptance. Do **not** run `git commit` / `git add` / `git push`.
- **Write the version report**: Every version/phase ends with a report at `<workspace>/docs/[version]_doc.md` (workspace `docs/`, *not* this repo's `docs/`). Reports are never overwritten by later versions.
- **No blind deletion**: Before removing code, prove it is unreferenced (see *Static verification* below). This fork's single biggest regression risk is deleting something that is still wired up.

## Sandbox Constraints (IMPORTANT)

The agent sandbox for this project normally has **no `node_modules`** and **cannot run `pnpm`**. Consequence:

- `pnpm lint` / `pnpm test` / `pnpm typecheck` / `pnpm build` are **not available**; do not claim you ran them.
- Verification is by **code review + static analysis**. Required steps for any non-trivial change:
  1. Grep every removed/renamed symbol and file path across `src/`, `packages/`, `scripts/`, `tests/`, and all root configs.
  2. Check **all three** reference forms: alias (`@renderer/...`, `@main/...`, `@shared/...`), relative (`./x`, `../x`), and barrel re-export (`export * from`, `export { x } from`).
  3. Re-grep after the change to prove zero dangling references.
- **Run the static-check suite** (built during the v0.2.4-1 cleanup, lives **outside** this repo so it is never committed):
  ```powershell
  node E:\Workspace\Re_Cherry\tools\static-checks\run-all.js
  ```
  It provides eight checks, and **all eight must be green** (exit code 0) after any batch of deletions/renames:
  - `check-imports.js` — every import/export/require/dynamic-import specifier resolves on disk (relative, aliases, `?url` query suffixes, NodeNext `.js`→`.ts`, bare packages vs `package.json`).
  - `check-symbols.js` — every `import { a } from '<local path>'` is really exported there (handles this repo's three export shapes: `export const X`, `export const { a, b } = slice.actions` with comments in between, `export { default as X, type Y } from './z'`).
  - `check-syntax.js` — parses all `.ts` via Node's `stripTypeScriptTypes` (a syntax-level substitute for `tsgo`; `.tsx` cannot be checked because JSX is unsupported).
  - `check-configs.js` — `package.json` / `tsconfig*.json` / `.oxlintrc.json` (JSONC-tolerant) / `pnpm-workspace.yaml` / `electron-builder.yml` parse, carry no BOM, and keep `patches/` in 1:1 correspondence with `patchedDependencies`.
  - `check-i18n-parity.js` — `en-us.json` and `zh-cn.json` must have identical leaf-key sets.
  - `check-main-i18n.js` — **the main process must be able to read its own strings.** The main process accesses locales by *object value* (`const { tray: trayLocale } = locale.translation`), so `'tray.show_window'` never appears as a literal anywhere in the source and a text-driven prune deletes the whole namespace. This check verifies the namespaces exist, their member keys resolve to strings, and every `t('a.b.c')` literal resolves.
  - `check-i18n-keys.js` — every quoted dotted string that starts with a locale namespace resolves in both bundles, with i18next plural/context awareness (`_one`/`_other`/`_male` have no bare key). Compared against `i18n-baseline.json`: **only new misses fail**; pass `--head <dir>` to diff against a HEAD snapshot and separate regressions from pre-existing upstream gaps.
  - `check-i18n-dynamic.js` — template-literal keys (`` `error.${x}` ``) have no dotted literal either. New unregistered shapes fail; registered ones must declare resolvable `expandsTo` keys; the conversation-importer registry must have matching `import.<name>.assistant_name` keys.
  Known false positives and usage discipline are documented in `tools/static-checks/README.md` — read it before acting on a report. **Never prune text-driven content (i18n keys, barrels, side-effect imports) without first enumerating every way that text can be consumed** — literal, object value, template literal, variable key table, barrel forward, side-effect import. See the incident record in that README.
- These checks catch broken references, syntax and config breakage, **not** type errors (e.g. a deleted state field still written in a file typed with `RootState`). When you delete a field/type, grep every consumer including `store/migrate.ts`, and prefer deleting the now-dead statements over adding `@ts-expect-error`.
- **Startup order is a safety property** (`src/main/index.ts`): `registerShortcuts()` and `await registerIpc()` must stay ahead of every cosmetic/optional initializer (tray, macOS app menu, telemetry), and those must stay wrapped in `try/catch` that only logs. A cosmetic failure must never take the app's basic usability with it.
- If a change genuinely needs a typecheck or a test run, say so and hand the exact command to the user instead of guessing.

## Project Rules Specific to This Fork

- **Kernel-plugin compatibility contract** is a hard acceptance gate: see `<workspace>/docs/内核插件兼容契约.md`. Never bypass the cordis `ctx.plugin` lifecycle or the public seams (`ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`, `ToolRuntime`, `session/event`). IPC handlers are thin forwarders only; do not scatter direct SQLite access outside the kernel.
- **The kernel session log is the single source of truth.** The renderer is a projection of kernel events. Any conversational state must be recoverable by folding the session log — no parallel sources of truth.
- **`src/main/kernel/topics.ts`** owns topics (= dsh session + agent) including the `destroyTurns` deletion engine. Structural operations go through the `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning` service seams (`src/main/kernel/services.ts`).
- **`src/renderer/src/services/kernelChat.ts`** is the event-projection bridge (its name is similar to the legacy `services/messageStreaming/**` layer — do not confuse them).
- Version roadmap and per-version goals live in `<workspace>/docs/当前任务总体规划.txt`; the work-mode (agent toggle) design is in `docs/work-mode-evolution.md` of this repo.

## Development Commands (run on the user's real machine)

- **Install**: `pnpm install` — requires Node ≥24.11.1, pnpm 10.27.0
- **Development**: `pnpm dev` — Electron app in dev mode with hot reload (dev server port 5270). Dev mode does **not** install React/Redux DevTools unless `RC_DEVTOOLS=1` is set (the download from the Chrome Web Store retries 5× and takes ~60s when the network is restricted).
- **Debug**: `pnpm debug` — attach via `chrome://inspect` on port 9222
- **Typecheck**: `pnpm typecheck` — concurrent `tsgo` node + web checks
- **Full Build**: `pnpm build` — typecheck + electron-vite build
- **Build Check**: `pnpm build:check` — `pnpm lint && pnpm test`
- **Test**: `pnpm test` (all) / `test:main` / `test:renderer` / `test:shared` / `test:scripts` / `test:e2e` (Playwright)
- **Lint**: `pnpm lint` — oxlint + eslint + typecheck + i18n check + format
- **Format**: `pnpm format` — Biome write mode
- **i18n**: `pnpm i18n:check` (validate) / `pnpm i18n:sync` (sync + sort keys)
- **Bundle Analysis**: `pnpm analyze:renderer` / `pnpm analyze:main`
- **Release packaging**: `pnpm build:win:x64`, `build:mac*`, `build:linux*`, `release` (see `electron-builder.yml`)

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
| `index.ts` | Programmatic plugin assembly (settings-file + credentials + llm + pi-ai adapter + system prompt + tools + session store/SQLite persistence + title service + agent registry/loop) and all `dsh:*` IPC |
| `topics.ts` | Topic registry & chat operations; topic = dsh session + agent; `destroyTurns` deletion engine; reasoning-level convergence |
| `providers.ts` | Renderer provider config → pi-ai routes (`KernelProviderInput`); clears stale routes on resync |
| `credentials.ts` | In-memory credential provider (`CherryCredentialProvider`), multi-key rotation per request |
| `services.ts` | App service seams: `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning` (plugins may take over) |

Renderer side: `src/renderer/src/services/kernelChat.ts` subscribes to kernel `session/event` and projects messages/blocks into Redux. The **quick assistant** (mini window) is the one deliberately separate path: it calls `window.api.dshStreamComplete` without a kernel session.

### Renderer Process (`src/renderer/src/`)

React 19 + Redux Toolkit SPA. Routes (`Router.tsx`): `/` (home), `/files`, `/settings/*`.

```
components/      # Shared UI (Ant Design 5 + styled-components + TailwindCSS v4)
databases/       # Dexie (IndexedDB): files, settings, knowledge_notes, quick_phrases
hooks/           # React hooks (useAppInit, useAssistant, useChatContext, useSettings, ...)
pages/           # files, history, home (chat + Inputbar + Messages), onboarding, settings
services/        # ApiService, kernelChat, BackupService, MemoryService, ...
store/           # Redux Toolkit slices (+ thunk/ for message operations)
types/           # TypeScript type definitions
workers/         # Web Workers (pyodide, shiki-stream)
windows/         # Mini window entry point
```

### Redux Store (`src/renderer/src/store/`)

Slices: `assistants`, `backup`, `copilot`, `inputTools`, `llm`, `memory`, `messageBlock`, `minapps`, `newMessage`, `nutstore`, `runtime`, `settings`, `shortcuts`, `tabs`, `toolPermissions` (persist config + migrations in `index.ts` / `migrate.ts`).

- `migrate.ts` uses `{'2': fn, ..., '213': fn}`-style migrations. **Every branch is reachable** (redux-persist runs all keys with `currentVersion >= key > inboundVersion`), and a throw inside a branch discards the entire persisted state. Do not delete migration branches; when adding a branch, bump `version` in `index.ts` and the highest key in `migrate.ts` together.
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

`patches/` must stay in 1:1 correspondence with `patchedDependencies`. Current patches (4): `antd@5.27.0`, `atomically@1.7.0`, `file-stream-rotator@0.6.1`, `libsql@0.4.7`. (`check-configs.js` enforces the 1:1 rule; the former `@tiptap/extension-drag-handle` patch went away with the RichEditor removal.)

## Testing Guidelines

- Vitest 3 with project-based configs; main tests run in Node (`tests/main.setup.ts`), renderer tests in jsdom (`tests/renderer.setup.ts`, `@testing-library/react`).
- Coverage via v8 (`pnpm test:coverage`); e2e via Playwright (`tests/e2e/`).
- A module whose only reference is its own `__tests__` file is dead code — prefer deleting module + test together over keeping tests for unreachable code.

## Important Notes

### Security

- Never expose Node.js APIs directly to the renderer; use `contextBridge` in preload.
- Validate all IPC inputs in the main-process handlers.
- Provider API keys: persisted encrypted via `ProviderKeyStore`; a redux-persist transform strips non-empty `apiKey` from localStorage.

### Deprecation Headers

Some files still carry the upstream `⚠️ NOTICE: V2 DATA&UI REFACTORING` / `@deprecated Scheduled for removal in v2.0.0` header. Those headers refer to **upstream Cherry Studio's** v2 refactor and are not authoritative here. Treat them as ordinary code; the fork's own roadmap (`docs/当前任务总体规划.txt` in the workspace) decides what is deprecated.
