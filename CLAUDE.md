# AI Assistant Guide

**Re_Cherry** — personal fork of Cherry Studio v1.9.11, heavily trimmed, with the chat/agent message path unified onto an in-process **DSH (DeepSeek Harness) Cordis kernel** ("everything is a plugin"). Most upstream Cherry Studio documentation no longer applies as written: upstream subsystems (agent pages, apiServer, updater, Copilot, Pyodide, OVMS, selection toolbar, Drizzle agents DB) were removed; MCP · knowledge base · web search · skills · translate/paint/notes/files pages were **re-implemented the fork's way** and are live. When in doubt, read the code.

## Roadmap (from the project plan)

- **Main goal**: unified agent+chatbot page/logic, wired to MCP and skills, with in-chat one-tap switch between pure chat / safe-tools chat / full working mode.
- **Side goals**: port CS v2 edge features (translate, KB, paint) as modules (done); web pages as mini-apps (done).
- **Versions**: v0.3.4-1 shipped (minapps, Code Mate, community stack). **v0.4** shipped: debt paid off, docs consolidated into this file, dead code removed, and the engineering items landed (main-process Readability extraction, KB sitemap/directory/video ingestion, xlsx/pptx Markdown fidelity, OCR DirectML/CoreML acceleration, MCPService file-by-file reconciliation with upstream, console-window flash eliminated via `windowsHide` on all main-process spawns incl. the subprocess-local patch). **v0.4.6** shipped (V2 tool-porting survey + five V2-parity tools — `web_fetch`/`knowledge_read`/`move_to_trash`/`save_attachment`/`memory` — plus dsh-native `todo_write` + goal trio; per user ruling memory/todo/goal are **external** tools (work-mode scope — they persist state outside the session) with a work-mode task panel (ChatNavBar button → right drawer folding `todo/write` + `goal/change` session events via `services/sessionTaskState`); escalation flow rides `@deepseek-ai/dsh-sandbox` helpers; full candidate ledger incl. deferred Browser-MCP/cron/MCP-OAuth lives in `tools/notes-v046-v2-tool-survey.md`). **v0.4.6-1** shipped (thinking-timer freeze fix — single `freezePendingThinking` end-marker, frozen value = freeze moment − reasoning start, stamped at first text-delta/tool/step/turn settle; rAF flush queue releases entries on dispatch errors; main-text streaming stall under investigation — kernel emission proven live via sessions.db `dt` arrays, projection covered by `kernelChat.streamingProjection.test.ts` per-delta gate, >1s-gap forensic hook in place). **v1**: full review, deploy, ship.

## Environment

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node ≥24.11.1; DSH's bundled Node is too old
$env:CI = "true"                        # avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
```

- **pnpm does not run in the sandbox** (`spawn EPERM`, deterministic). Read the pnpm script in `package.json` and invoke the same binary from `node_modules/.bin/` directly: `tsgo`, `vitest`, `oxlint`, `eslint`, `biome`, `electron-vite`. Ask the user to grant pnpm only when install/packaging genuinely requires it.
- **Typecheck verbatim**: `tsgo --noEmit -p tsconfig.node.json --composite false` and `-p tsconfig.web.json --composite false`. Omitting `--composite false` both fakes TS4023/TS2742 errors and **emits ~2000 stray `.js`/`.d.ts` into `src/` that hijack vite module resolution** (delete them and confirm via `git status` before continuing).
- Copy gate commands verbatim from `package.json` scripts (flags matter). On red: compare against HEAD (stash) → verify the command → only then suspect code.
- After any `resolveJsonModule`-imported JSON shape change (e.g. locale files), delete `*.tsbuildinfo` before tsgo — stale incremental cache produces fake "property does not exist" error families.
- **Windows shell traps**: trust only the real exit code captured immediately after a command (pipelines swallow/alter codes); PowerShell 5.1 mis-decodes ANSI and writes UTF-16LE by default — read via file tools / `[System.IO.File]::ReadAllText`, write UTF-8 no BOM. In Git Bash, `${PIPESTATUS[0]}` recovers the pre-pipe exit code.
- **vitest uses the forks pool** (threads pool crashes natively on this machine). Timing is never a regression signal — exit codes and test counts are. A full-suite red under parallel load must be re-run on an idle machine before it counts.
- Lint chains with `--fix` do semantic rewrites (e.g. `useContext` → `use`) and may land half-done — always follow with both typechecks.

## Static-check suite (10 checks, lives outside the repo)

```powershell
node E:\Workspace\project_REC\tools\static-checks\run-all.js
```

Mandatory after: deleting/renaming/moving files, import/export surface changes, i18n key changes, config/packaging edits (`package.json`, lockfile, `electron-builder.yml`, `patches/`, `tsconfig*`, `vitest.config`). Not required for pure style/copy/local-logic edits — those get typecheck + touched-area tests. The suite covers references/syntax/config/i18n/upstream parity — **not types**; it cannot replace tsgo.

**Before any deletion judged "unreferenced"**: enumerate all six consumption forms (string literal / object-value lookup / template literal / variable key table / barrel re-export / side-effect import) and cross-validate with two methods that don't share blind spots (alias vs relative vs barrel; type name vs variable name vs usage). i18n is the classic trap: the main process reads locale keys by object value, so `'tray.show_window'` appears nowhere as a literal.

## Hard invariants

| # | Invariant |
|---|---|
| 1 | Kernel-plugin compatibility contract is a hard acceptance gate: never bypass the cordis `ctx.plugin` lifecycle or public seams (`ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`, `ToolRuntime`, `session/event`). IPC handlers are thin forwarders; structural operations go through `ctx.topicTree` / `ctx.sessionGC` / `ctx.reasoning`; no direct SQLite outside the kernel; never rename dsh session-event vocabulary. |
| 2 | The kernel session log is the single source of truth; the renderer is a projection. Every conversational state must be recoverable by folding the log — no parallel sources of truth. Wire-side transforms (e.g. prior-turn thinking trim) must never touch the DB. |
| 3 | Topic membership is the kernel's to decide (`dshTopicList` is authoritative); only rows restored from a previous session may be judged stale. A topic id deleted in the kernel is never resurrected. |
| 4 | `ensureAgent` may never silently create a session over an existing log — `sessionResumeFallback.ts` is the single decision point (persistence existence query, fail-closed). Error *types* are diagnostic only. |
| 5 | Every kernel query tolerates the boot window via `retryKernelQuery`; a definitive answer — including a negative — returns immediately; `null` means "no answer" and never justifies refusing or hiding anything. |
| 6 | An unknowable state never authorizes a destructive action: registry `failed` ≠ `absent`; sweep skipped + file backed up on parse failure. Same shape everywhere: never treat "no answer" as "empty". |
| 7 | The renderer holds no event-visibility predicate — `sessionEventView.ts` is the only one, applied at all three UI exits (live broadcast, `uiEvents`, search). Visibility is solved structurally, not by per-path patching. |
| 8 | Startup order is a safety property (`src/main/index.ts`): `registerShortcuts()` and `await registerIpc()` stay ahead of cosmetic/optional initializers, which stay wrapped in log-only `try/catch`. |
| 9 | Kernel-package intrusion only where a public seam cannot reach, then only as a one-line `globalThis` **neutral gate** (gate absent = upstream-identical); response-side changes go through the documented `llm/stream` waterfall. Cosmetic issues never justify kernel patches (user veto). |
| 10 | The trace stack (`packages/mcp-trace/` + `NodeTraceService` + `SpanCacheService` + trace window) is a live feature; the package name is historical. |

## Judgment rules (distilled from incidents)

**Data & failure semantics**
- Failures must never masquerade as empty results; a failed fetch rejects, never renders a partial/fake tree. Silent failure is forbidden: log + user-visible signal, even for fire-and-forget writes.
- Deletion returns `Promise<boolean>`; optimistic rows go back on failure + `toast.error`; batch deletion surfaces "N succeeded / M failed" as a real signal.
- Three-value contract for kernel queries: `undefined` = retryable (delay only after failure); any other value including `false`/empty = definitive, return immediately; `null` = unanswerable — only `false` may reject.
- API keys: encrypted at rest via `ProviderKeyStore`; decrypt failure = "no key" (never add plaintext fallbacks or degraded paths). A redux-persist transform strips non-empty `apiKey` from localStorage.
- Custom session events must set `ignorable: true` on the envelope, or old rows become unreadable and need an idempotent migration to fix.
- Empty extraction results (empty file / scanned doc) return a neutral one-line note as a normal tool result — not an error.

**Redux / persistence**
- Adding any field to a persisted slice requires a migrate backfill branch (`initialState` never reaches existing users — redux-persist replaces the whole slice). Never delete migrate branches; bumping `version` means updating it in `store/index.ts` and the highest key in `migrate.ts` together.
- `blacklist` in persist config means "not written to localStorage", not "unused". Cross-reboot state belongs in a persisted slice with a mirror-out/idempotent-restore pair.
- Any store reading `app.getPath()` (or any "redirection already happened" global) must lazy-construct — the bundler decides module require order, not source order.

**Rendering / blocks**
- Every `createXxxBlock` call passes explicit `status`; renderers must show skeleton/placeholder for every state (and for blocks missing an address) — silent invisibility is the worst failure shape.
- `overflow` + `max-height` containers: declare both axes explicitly (`overflow-x: hidden` + `scrollbar-gutter: stable`) or a self-sustaining width↔reflow↔height oscillation appears.
- Interaction-contract changes (layout skeleton, collapse/expand, overlays, answer/approval entry) need behavior-level proof — a dev-instance sample the user eyeballs, or a behavior test — never a static blast-radius argument.

**i18n**
- zh-CN + en-US only; all user-visible strings through i18next. Feature namespaces stay top-level (nested keys are invisible to the keys gate). Missing-key fallback uses `defaultValue` — `t('k') || 'fallback'` never fires because i18next returns the key itself.
- Never prune i18n keys, barrels or side-effect imports without the six-form enumeration (see static-check section).

**Text style (ASD-STE100, 2026-09-28 user ruling)**
- **Tool-injection texts follow ASD-STE100 absolutely**: tool `description`s, parameter descriptions and context-snapshot sections. They are injected every turn and billed per token — short sentences, active voice, one instruction per sentence; no implementation self-praise ("handled in-process", "no external tools"), no provider/config lists the runtime resolves anyway, nothing the context snapshot already carries.
- In-app UI description texts follow ASD-STE100 as much as the wording allows.
- Document/file names in context lists are **quoted** (names contain spaces and mixed scripts; an unquoted name with a trailing extension marker got mis-transcribed on the first tool call — the quoting bug of 2026-09-28). Never append redundant extension markers to a name that already ends with its extension.

**Gates & testing**
- A new gate/guard is not proven until a reverse-control probe turned it red: plant a break, watch the specific check fail by name, remove it, confirm clean `git diff`.
- State each green's scope: typecheck / lint chain / static suite / build cover different things; lint runs no tests; static suite runs no types.
- A module whose only reference is its own test file is dead — delete module + test together. A single export in an active module referenced only by its own test is **not** dead (rollup tree-shakes it).
- Behavior differences that all gates miss: third-party shim prop routing (rc-* passes only `COMMON_PROPS` to the inner element; antd Popover injects via cloneElement onto its direct child), runtime CSS-in-JS overriding Tailwind size classes, undefined Tailwind/design tokens failing silently. After porting UI, scan built CSS for the class/variable names actually consumed.

**Porting from V1/V2 (参考资产/)**
- First inventory upstream originals (glob same-name dirs/components). "Upstream has an original" vetoes self-made shells — port page skeleton, class-constant tables and semantic design tokens together, or the result is silently wrong.
- Search 参考资产/ only for a specific named target (it is ~170k files); prefer delegating to a subagent with scoped searches.
- When judging "this fork can't do X", compare upstream `package.json` too — the capability may have been lost with a pruned dependency, not unimplemented.
- Upstream `⚠️ V2 REFACTORING` / `@deprecated` headers refer to upstream's refactor — treat as ordinary code; the fork roadmap decides.
- Every shim prop must be consumed, explicitly ignored with a reason comment, or removed from the signature. Ported early-returns/guards must have their original-host preconditions re-verified in the fork.
- One business criterion per scenario (e.g. image-generation): derived predicates are negations or refinements of the single source of truth — never a second id-list that drifts.

**Subprocess / native**
- Electron utility workers: `parentPort` only via `process.parentPort` (the d.ts export is a lie); worker-side messages arrive as `MessageEvent` (unwrap `.data`), main-side `utilityProcess` messages as bare values; main-process forks use `stdio: 'pipe'` wired to the logger so child crashes are forensically available.
- Windows: `env.PATH` is case-sensitive on plain objects — normalize (`withPathPrepend` pattern); EPERM/EBUSY on delete/rename right after killing processes = antivirus/DLL-lock window, retry with backoff.
- Killing processes must match CommandLine precisely (list before kill) — Electron app, agent hosts and targets may all be `node.exe`.
- electron-builder's pnpm collector cannot see optionalDependencies of a top-level-resolvable package (its existence check walks top-level node_modules only and skips dot-dirs, so pnpm's `.pnpm` virtual store is invisible) — platform binaries like `@img/sharp-win32-x64` get silently dropped from the package (v0.4.3 and earlier: installed-build LocalPaddle died at `import('sharp')`, dev was green). House pattern: declare runtime platform binaries as root `optionalDependencies` (the root package's own optionalDeps bypass the broken check — same as `@libsql/*`), add explicit `asarUnpack` entries for the native closure, and `scripts/after-pack.js` asserts the unpacked natives exist (this gap must turn red at build time, never on a real machine).

## Architecture

```
src/
  main/          # Electron main process — hosts the dsh kernel (src/main/kernel/)
  renderer/      # React SPA (components/ databases/ hooks/ pages/ services/ store/ types/ workers/ windows/)
  preload/       # contextBridge IPC → window.api
packages/
  shared/        # cross-process types, constants, IPC channel definitions
  mcp-trace/     # OpenTelemetry trace-core + node/web adapters (LIVE, name historical)
```

Entry: `src/main/index.ts` → `bootstrap.ts` → `kernel/index.ts` (kernel boot) + `ipc.ts`. Windows: `index.html` (main) · `miniWindow.html` (quick assistant) · `traceWindow.html`.

Aliases: `@main` → `src/main/`, `@renderer` → `src/renderer/src/`, `@shared` → `packages/shared/`, `@types` → `src/renderer/src/types/`, `@logger` → LoggerService (per side).

**Kernel** (`src/main/kernel/`): `index.ts` (programmatic plugin assembly + `dsh:*` IPC) · `topics.ts` (topic registry & chat ops) · `providers.ts` (renderer config → pi-ai routes) · `credentials.ts` (in-memory credential provider, per-request multi-key rotation — pointer not persisted) · `services.ts` (`ctx.topicTree`/`ctx.sessionGC`/`ctx.reasoning` seams) · `sessionEventView.ts` (the injected-event predicate) · `dsmlRepair.ts` (response-side DSML repair as waterfall middleware) · `thinkingReplay.ts` (request-side prior-turn thinking trim behind the neutral gate) · `sessionResumeFallback.ts` (the refuse-vs-create decision point) · `sessionReadFailure.ts` (classification, logging only — never gates creation). Topic auto-naming runs renderer-side (`services/topicNaming.ts`) and writes via `Dsh_TopicRename`. The quick assistant (mini window) is the one deliberate separate path: `window.api.dshStreamComplete` without a kernel session; its preload listeners must not be removed when `invoke` lands (terminal events race the reply — see `STREAM_TERMINAL_GRACE_MS`).

**Data**: chat lives in kernel SQLite (`{userData}/kernel/sessions.db` + `settings.json` pi-ai routes); provider keys in `{userData}/provider-keys.json` (encrypted). IndexedDB (Dexie) tables are whatever `db.version(n).stores` in `src/renderer/src/databases/index.ts` declares (files, settings, knowledge_notes, quick_phrases, translate_records, paintings; old chat tables dropped). Notes are plain `{userData}/Data/Notes/*.md`, not Dexie. redux-persist migrations: every branch reachable, a throw discards all persisted state.

**IPC**: channel constants in `packages/shared/IpcChannel.ts`; handlers in `src/main/ipc.ts` + `kernel/index.ts`; bridge in `src/preload/index.ts`. Adding/removing a channel updates all three layers.

**Build/config facts**: `electron.vite.config.ts` externalizes *all* `dependencies` — anything main `require`s at runtime must stay there (removal breaks at runtime, never at build). pnpm config (`overrides`, `patchedDependencies`, `onlyBuiltDependencies`) lives in `pnpm-workspace.yaml`, not `package.json`. Runtime-needed peer-only packages must be root-declared (dev-green ≠ shipped closure; static check `check-package-runtime-closure` guards this). Dev port 5870 (`DSH_DEV_PORT`); fork runtime constants changed from upstream (ports/paths/origins/env) must be grepped at their old values and audited; functional identifiers (`cherrystudio://` protocol, backup default filename, third-party app ids) are rename-locked.

**Logging**: `loggerService.withContext('Module')`; never `console.log`. renderer `info` doesn't reach disk — forensic hooks use `warn` or a diagnostics switch.

## Delivery discipline

- Packaging is a delivery action: one build per delivery batch (`pnpm build:win:x64 --publish never` — `--publish never` is not optional, CI mode tries a GitHub publish and fails the run). Verify intermediates on `pnpm dev`, never by shipping intermediate builds (`dist/` same-name artifacts overwrite). Read the build-log tail before verdicts.
- Never expose Node APIs to the renderer — `contextBridge` in preload; validate IPC inputs in main handlers.
- After deleting a feature, recover its security relaxations (sandbox defaults, allowlists) in the same batch.

## Known accepted limitations / deliberate keeps (don't "fix" unasked)

- ~130 i18n orphan keys deliberately kept (pruning = rewrite next version).
- The image-generation preset implementation (collect/generate/edit trio) is deliberate, not upstream garbage.
- A zero-referenced SDK chunk is the ripgrep binary source — re-source ripgrep **before** removing that dependency.
- Windows sandbox children spawn with `CREATE_NEW_CONSOLE + STARTF_USESHOWWINDOW(SW_HIDE)` (patch on `dsh-sandbox-windows-acl`, both restricted spawn sites). The restricted-token scheme **forbids `CREATE_NO_WINDOW`** — hidden-console children die with 0xC0000142 (empirically established upstream) — and the Electron host has no console for children to share, so without the patch every pwsh/fs child allocated a *visible* console. Do not "simplify" it back to `windowsHide`.
- Knowledge-base retrieval is O(n) cosine (fine at personal scale); rerank is a type-only shape.
- `agents.create({ sessionId })` upstream semantics on existing log ids were never proven — three fork versions routed around it; re-verify only on a kernel major upgrade.
- `PasteService` prefers text over images when both are pasted (fork-inherited semantics; V2 swallows via TipTap runtime) — changing it means reworking the paste parser.
- The deprecated top-level `Provider.isNotSupport*` fields are migration-input carriers (read by `store/migrate.ts`); three of four are also live via utils/UI — do not strip them from the type.
- electron-builder asar collection mechanism (was "dsh-invariants 入包通道未定性", resolved 2026-09-27): the `pnpm list --prod --depth Infinity` **report layer includes the whole peer closure** (~16.5k mentions of dsh-invariants alone), and the collector's filter only checks name membership, never regex edges — so peer-dense packages always ship (over-collection is the design; under-collection happens only when the report layer omits a pure peer, which is what the root-manifest rule + `check-package-runtime-closure` guard against).
