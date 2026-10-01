# Re_Cherry — Development Guide

## 1. Project summary

Re_Cherry is a personal desktop AI assistant. It is a heavily trimmed fork of Cherry Studio v1.9.11.
The chat path uses one in-process kernel: **DSH** (DeepSeek Harness, Cordis-based, "everything is a plugin").
The fork removed the upstream agent pages, apiServer, updater, Copilot, Pyodide, OVMS, selection toolbar, and Drizzle agents DB.
The fork re-implemented MCP, knowledge base, web search, skills, translate, paint, notes, and files pages its own way.
Current version: **0.5.2**. This is the third cleanup round before the 1.0.0 release. Read the code when a document disagrees with it.

## 2. Project structure

```
src/
  main/                     Electron main process. Hosts the DSH kernel.
    bootstrap.ts            Redirects the app data directory. Runs first.
    index.ts                App entry. Creates the window, starts the kernel.
    ipc.ts                  All IPC handlers except kernel channels.
    kernel/                 Fork-owned kernel integration layer.
    services/               Main-process services (MCP, knowledge, binary manager, backup, ...).
    features/               Feature packages (API gateway, ...).
    utils/                  Main-process helpers.
  preload/                  contextBridge. Exposes window.api.
  renderer/                 React SPA.
    src/pages/              Route pages. Each page is a lazy chunk except the home page.
    src/components/         Shared components.
    src/services/           Renderer services (kernelChat, kernelEventStream, ...).
    src/store/              Redux slices and redux-persist migrations.
    src/databases/          Dexie (IndexedDB) schema.
    src/hooks/, src/utils/, src/types/, src/windows/, src/workers/
packages/
  shared/                   Cross-process types, constants, IPC channel names.
  mcp-trace/                OpenTelemetry trace core with node and web adapters. Live feature.
docs/                       Delivery and operations documents.
scripts/                    Build, packaging, and i18n scripts.
tests/                      Unit setup and Playwright end-to-end specs.
```

Path aliases: `@main` → `src/main/`, `@renderer` → `src/renderer/src/`, `@shared` → `packages/shared/`,
`@types` → `src/renderer/src/types/`, `@logger` → LoggerService (one file per process side).

Entry chain: `src/main/index.ts` → `bootstrap.ts` → `kernel/index.ts` + `ipc.ts` → `windowService.createMainWindow()`.
Renderer chain: `index.html` → `entryPoint.tsx` → `init.ts` → `App.tsx` → `Router.tsx`.
Three HTML entries exist: `index.html` (main window), `miniWindow.html` (quick assistant), `traceWindow.html`.

## 3. Development setup

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node 24.11.1 or newer. The DSH bundled Node is too old.
$env:CI = "true"                        # Stops pnpm from failing on a missing TTY.
```

`pnpm` works when the file sandbox allows process spawn. When it does not, call the tools in `node_modules\.bin\`
directly: `tsgo`, `vitest`, `oxlint`, `eslint`, `biome`, `electron-vite`. Only install and packaging need `pnpm`.
Dev server port: 5870. Override it with `DSH_DEV_PORT`.

## 4. Commands

| Task | Command |
|------|---------|
| Dev server | `pnpm dev` |
| Typecheck (node side) | `tsgo --noEmit -p tsconfig.node.json --composite false` |
| Typecheck (web side) | `tsgo --noEmit -p tsconfig.web.json --composite false` |
| Lint | `oxlint --deny-warnings` then `eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts` |
| Format check | `biome format` and `biome lint` |
| Static checks | `node E:\Workspace\project_REC\tools\static-checks\run-all.js` |
| Unit tests | `vitest run --silent` |
| Production build | `electron-vite build` |

Always pass `--composite false` to `tsgo`. Without it, tsgo reports false TS4023 and TS2742 errors.
It also writes about 2000 stray `.js` and `.d.ts` files into `src/`. Those files break Vite module resolution.

The unit tests use the forks pool. The threads pool crashes on this machine.
Do not use timing as a regression signal. Use exit codes and test counts.
Re-run a failed full suite on an idle machine before you report a regression.

## 5. Quality gates

Run the gates after you change files. Keep each green:

1. Both typechecks.
2. `oxlint --deny-warnings`.
3. `eslint`.
4. `biome format` and `biome lint`.
5. The static-check suite.
6. `vitest run --silent`.
7. `electron-vite build`.

Run the static-check suite after you delete, rename, or move a file.
Also run it after you change an import or export surface, an i18n key, or a build config
(`package.json`, the lockfile, `electron-builder.yml`, `patches/`, `tsconfig*`, `vitest.config`).

Each gate covers a different area. Types cover the type graph. Lint covers style and local rules.
The static suite covers references, syntax, config, and i18n. It does not cover types.
Tests cover behavior. The build covers bundling.

### 5.1 Delete rules

Before you delete a file or a symbol that looks unused, list all six consumption forms:

1. String literal.
2. Object value lookup (a key table stores the name).
3. Template literal.
4. Variable key table.
5. Barrel re-export.
6. Side-effect import.

Then confirm with two methods that do not share a blind spot.
Example: search by alias and by relative path. Search by type name and by value usage.

i18n is the usual trap. The main process reads some locale keys by object value.
Those keys never appear as literals. Literal scans cannot find their consumers.

A module is dead when its only reference is its own test file. Delete the module and the test together.
An export is not dead when an active module uses it, even if only a test imports it. Rollup removes unused exports.

## 6. Architecture rules

These rules are hard. Do not break them.

1. **The kernel is a restricted zone.** Do not edit the `@deepseek-ai/*` packages in `node_modules`.
   Do not edit the files in `patches/`. Do not bypass the Cordis plugin lifecycle.
   Use the public seams only: `ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`, `ToolRuntime`, `session/event`.
   Keep IPC handlers thin. Send structural work through `ctx.topicTree`, `ctx.sessionGC`, and `ctx.reasoning`.
   Do not open SQLite outside the kernel. Do not rename dsh session events.
2. **The kernel session log is the only source of truth.** The renderer projects that log.
   Every conversational state must be recoverable by folding the log. Do not add a second source of truth.
   Do not let wire-side transforms touch the database.
3. **The kernel decides topic membership.** `dshTopicList` is authoritative.
   Only rows restored from an earlier session can be stale. Never revive a deleted topic id.
4. **`ensureAgent` must never create a session over an existing log.** `sessionResumeFallback.ts` makes that decision.
   It queries persistence for existence and fails closed. Error types are diagnostic only.
5. **Every kernel query tolerates the boot window.** Use `retryKernelQuery`.
   A definitive answer returns at once, including a negative answer. `null` means "no answer".
   `null` never justifies a refusal and never justifies hiding data.
6. **An unknowable state never authorizes a destructive action.** Registry `failed` is not `absent`.
   Skip the sweep and back up the file when parsing fails. Never treat "no answer" as "empty".
7. **The renderer holds no event-visibility predicate.** `sessionEventView.ts` is the only predicate.
   Apply it at all three exits: live broadcast, `uiEvents`, and search. Solve visibility in the structure.
8. **Startup order is a safety property.** In `src/main/index.ts`, keep `registerShortcuts()` and
   `await registerIpc()` before cosmetic initializers. Wrap each optional initializer in a log-only `try/catch`.
9. **Patch a kernel package only when no public seam reaches the problem.** Then add one `globalThis` gate line.
   The gate must be neutral: when the gate is absent, the package behaves exactly like upstream.
   Send response-side changes through the documented `llm/stream` waterfall. Never patch for a cosmetic issue.
10. **The trace stack is live.** It includes `packages/mcp-trace/`, `NodeTraceService`, `SpanCacheService`,
    and the trace window. The package name is historical.

## 7. Data and state

| State | Location |
|-------|----------|
| Chat sessions | Kernel SQLite: `{userData}/kernel/sessions.db` |
| Provider routes | `{userData}/kernel/settings.json` |
| Provider keys | `{userData}/provider-keys.json`, encrypted by `ProviderKeyStore` |
| Topic registry | `{userData}/kernel/topics.json` |
| Files, notes index, phrases, translations, paintings, usage | Dexie tables in `src/renderer/src/databases/index.ts` |
| Notes bodies | Plain files under `{userData}/Data/Notes/*.md` |
| UI state | Redux slices, persisted with redux-persist |

Rules for persisted state:

- Adding a field to a persisted slice requires a migrate branch. `initialState` never reaches an existing user.
  redux-persist replaces the whole slice.
- Never delete a migrate branch. Keep `version` in `store/index.ts` and the highest key in `store/migrate.ts` equal.
- `blacklist` in the persist config means "do not write to localStorage". It does not mean "unused".
- A store that reads `app.getPath()` must construct lazily. The bundler decides module order, not the source order.
- The persist transform strips every non-empty `apiKey` before the write. Keep that behavior.
- A decrypt failure means "no key". Never add a plaintext fallback.

## 8. IPC contract

Three layers must stay in step:

1. Channel names in `packages/shared/IpcChannel.ts`.
2. Handlers in `src/main/ipc.ts` and `src/main/kernel/index.ts`.
3. The bridge in `src/preload/index.ts`.

When you add or remove a channel, update all three layers in one change.
Validate all IPC input in the main handler. Never expose a Node API to the renderer.

## 9. Coding rules

### Failure semantics

- A failure must never look like an empty result. A failed fetch rejects. It never renders a partial or fake result.
- Never fail silently. Log the failure and show a user-visible signal. Do this also for fire-and-forget writes.
- A deletion returns `Promise<boolean>`. Restore optimistic rows on failure and show `toast.error`.
- A batch deletion reports "N succeeded / M failed" as a real signal.
- Kernel queries use three values. `undefined` means "retry later". Any other value, including `false` and empty,
  is final. `null` means "no answer". Only `false` may reject.
- An empty extraction result returns a neutral one-line note as a normal tool result. It is not an error.
- Add `ignorable: true` to the envelope of a custom session event. Without it, old rows become unreadable.

### Logging

- Use `loggerService.withContext('Module')`. Never use `console.log`.
- Renderer `info` logs do not reach the disk. Use `warn` for forensic hooks, or use the diagnostics switch.

### i18n

- Ship two locales only: `zh-CN` and `en-US`.
- Put every user-visible string through i18next. Keep feature namespaces top-level. Nested keys are invisible to the key gate.
- Use `defaultValue` for a missing-key fallback. `t('k') || 'fallback'` never runs, because i18next returns the key itself.
- Prefer an explicit `Record` map over a template key. The compiler then checks exhaustiveness.
  Register a template key in `tools/static-checks/i18n-dynamic-registry.json` only when it is truly dynamic.
- Prune an orphan key only through the delete rules in section 5.1. Then run the static suite.
  The suite turns red when a deleted key is still used.

### Text style

- Write tool-injection text in ASD-STE100 style: tool descriptions, parameter descriptions, and context-snapshot text.
  Use short sentences and the active voice. Give one instruction per sentence.
  Do not praise the implementation. Do not list providers or config that the runtime resolves.
  Do not repeat what the context snapshot already carries.
- Write in-app UI description text in ASD-STE100 style as far as the wording allows.
- Quote file and document names in context lists. Names contain spaces and mixed scripts.

### Rendering

- Pass an explicit `status` to every `createXxxBlock` call.
- Show a skeleton or a placeholder for every state, and for a block that has no address.
  Silent invisibility is the worst failure mode.
- For a container with `overflow` and `max-height`, declare both axes. Add `overflow-x: hidden` and
  `scrollbar-gutter: stable`. Without them, a width-reflow-height loop can start.
- A UI interaction change needs behavior-level proof. Show a dev-instance sample, or add a behavior test.
  A static argument about blast radius is not proof.

### Subprocess and native code

- In an Electron utility worker, read `process.parentPort`. The `.d.ts` export is wrong.
  Worker-side messages arrive as a `MessageEvent`. Read `.data`. Main-side `utilityProcess` messages are bare values.
  Wire a forked main-process child with `stdio: 'pipe'` into the logger, so a crash stays available.
- On Windows, `env.PATH` is case-sensitive on a plain object. Normalize it. Use the `withPathPrepend` pattern.
- Match the CommandLine exactly before you kill a process. List first, then kill.
  The Electron app, agent hosts, and targets can all be `node.exe`.
- electron-builder cannot see the `optionalDependencies` of a top-level-resolvable package.
  Declare runtime platform binaries as root `optionalDependencies`. Add `asarUnpack` entries for the native closure.
  `scripts/after-pack.js` asserts that the unpacked natives exist. Keep that assertion.

### Build and config

- `electron.vite.config.ts` externalizes all `dependencies`. Anything the main process `require`s at runtime stays there.
  A removal breaks at runtime, not at build time.
- Keep pnpm config (`overrides`, `patchedDependencies`, `onlyBuiltDependencies`) in `pnpm-workspace.yaml`.
- Declare a runtime-needed peer-only package in the root manifest. `check-package-runtime-closure` guards this.
- Keep the `cherrystudio://` protocol, the backup default filename, and third-party app ids. These names are locked.
- The renderer splits by route. `Router.tsx` imports the home page statically and lazy-loads the other pages.
  Keep the Suspense fallback. Do not load a heavy library on the first paint.

## 10. Release process

1. Run all gates from section 5 on a clean tree.
2. Bump the version in `package.json`.
3. Update `releaseInfo.releaseNotes` in `electron-builder.yml`.
4. Commit and tag. Use `git tag -a v<version>`.
5. Package when the release needs artifacts: `pnpm build:win:x64 --publish never`.
   The `--publish never` flag is mandatory. Without it, CI mode tries a GitHub publish and fails.
6. Verify the packaged app before you ship it. Start it, open the chat page, and open a lazy route.

## 11. Deliberate decisions

Do not change these without a reason and a test.

- **Knowledge-base retrieval** uses an O(n) cosine scan. It is fast enough for a personal scale.
- **`PasteService`** prefers text over images when the clipboard holds both. Changing it requires a new paste parser.
- **`Provider.isNotSupport*`** fields look deprecated, but they are migration inputs and live UI inputs. Do not remove them.
- **Global memory is gone.** It had a structural defect: the model never calls for a fact it does not know.
  The only memory surface is the V2-style file memory. The `memory` tool runs in work mode, and the app injects `FACT.md` each turn.
- **`lodash`** stays as CommonJS. Alias mapping to `lodash-es` needs a new dependency and saves little.
- **Shiki** ships all language grammars. Each grammar is a lazy chunk. A web-subset bundle saves disk space,
  but it degrades uncommon languages to plain text.
- **`ComposerToolRuntime`** holds three inert V2-parity stubs. The painting composer consumes them.
- **`ImageViewer`** accepts `_`-prefixed unused props for antd compatibility.
- **The screenshot tool is not implemented.** The porting assessment is in `reports/cherry-v2-screenshot-porting-assessment.md`.
- **Windows sandbox children** spawn with `CREATE_NEW_CONSOLE` and `STARTF_USESHOWWINDOW(SW_HIDE)`.
  The restricted-token scheme forbids `CREATE_NO_WINDOW`. Children then die with `0xC0000142`.
  Do not replace this with `windowsHide`.

## 12. Open items

- **Main-text streaming stall (E1).** The stall itself is still not reproduced. The two rendering causes
  are fixed and measured (`reports/audit2-fixes/performance.md`, items p2-09 to p2-11): `Markdown` splits the
  text into a stable prefix plus a growing tail, so the pipeline runs a few times instead of once per frame;
  the smooth-stream callback is clamped to 30 Hz; and the store receives the new delta, not the whole text.
  Do not re-parse the whole message per frame. The forensic hook stays (`noteStreamActivity` in `kernelChat.ts`).
  It measures the gap between events of any type, so a thinking period or a tool period is not a stall.
  A gap over 5 seconds writes a warn line with the text `no stream activity`. Remove the hook only after a
  real stall is captured and fixed.
- **First-paint payload.** The first-paint face is the resource list in `index.html`
  (12,373,794 B raw bytes at 0.5.2, from 12,781,986 B at 0.5.1). The executed closure is 12,185,742 B.
  KaTeX and MathJax are lazy. Vite still writes a `modulepreload` hint for the KaTeX chunk, so the KaTeX
  change removes parse and execute cost, not the file read. The `store` chunk is 2,051,058 B (from 2,394,934 B).
  The large files `svg-*`, `esm-*`, `traceWindow-*`, and `viz-*` are **not** in the executed face — they are
  lazy chunks. `jsx-runtime-*` is a shared base (React, antd, i18n).
- **Do not add renderer `manualChunks`.** A measurement rejected that idea: grouping vendor libraries by package
  raised the first-paint face from 12.50 MB to 14.95 MB (+22.7%). Forced grouping breaks the default chunk that
  the first paint and the lazy routes share, so an eager consumer pulls a whole library in. Measure the first-paint
  total before and after any chunking change. Use `tools/audit2-fixes/measure-eager.cjs`.
- **Audit closure.** The second-pass review produced **337** findings in `reports/audit2/*.md`.
  Every finding now carries one terminal status. `reports/audit2-closure.md` holds the item table.
  Regenerate it with `node tools/audit2-closure.cjs`; the tail count must stay at zero.
  `reports/audit2-fixes/final-adjudication.md` holds the manual rulings for the items where the two passes
  disagreed. A new finding must be closed the same way. Do not register a handoff as a conclusion.

## 13. Related documents

`reports/…` and `tools/…` live in the development workspace beside this repository. They are not part of the
repository, and a fresh clone does not contain them. Treat them as development notes, not as shipped files.

- `docs/v1-internal-docs.md` — delivery, gates, deployment, and the performance baseline.
- `reports/v1-audit-ledger.md` — the v1 audit ledger with evidence and open items.
- `tools/notes-v046-v2-tool-survey.md` — the V2 tool-porting survey.
- `tools/notes-v047-feature-brainstorm.md` — the feature-freeze brainstorm ledger.
