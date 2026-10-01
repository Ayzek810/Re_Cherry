# Re_Cherry — Development Guide

## 1. What this project is

Re_Cherry is a personal desktop AI assistant for Windows. It is a trimmed fork of Cherry Studio v1.9.11.

The chat path has one engine: the DSH kernel (DeepSeek Harness, a Cordis plugin host). The kernel runs
in the Electron main process. The renderer holds no chat state. It projects the kernel session log.

The version is in `package.json`. Read the code when a document disagrees with it.

## 2. Work discipline

1. **The kernel is a restricted zone.** Do not change the kernel itself. Use the public seams only
   (section 7).
2. **Do not leave orphans.** A removed feature must not leave an unused key, channel, branch, or module.
3. **Repair the structure. Do not stack patches.** The code has known duplication and hidden defects.
   When a local fix adds another layer, rewrite that part instead.
4. **Close every finding.** A finding ends in one of three states: fixed; not a problem, with evidence;
   or not to fix, with the rule that forbids the change. Do not leave an open tail.
5. **Plan no rollback.** Repair forward and prove the result.

## 3. Layout

```
src/
  main/                      Electron main process. Hosts the DSH kernel.
    index.ts                 App entry. Creates the window, starts the kernel, registers IPC.
    bootstrap.ts             Redirects the app data directory. Runs first.
    ipc.ts                   IPC handlers for every channel except the kernel channels.
    kernel/                  Fork-owned kernel integration layer. See docs/kernel-integration.md.
    services/                Main-process services: MCP, knowledge, binary manager, backup, document
                             handling, web search, code CLI, ...
    features/apiGateway/     Local API gateway.
    core/ integration/ types/ utils/
  preload/index.ts           contextBridge. Exposes window.api.
  renderer/src/
    pages/                   Route pages. Home is static. The other pages are lazy chunks.
    components/              Shared components.
    services/                Renderer services: kernelChat, kernelEventStream, kernelTopics, ...
    store/                   Redux slices and redux-persist migrations.
    databases/               Dexie (IndexedDB) schema.
    i18n/locales/            Locale files: en-us.json, zh-cn.json.
    config/ context/ handler/ hooks/ queue/ trace/ types/ utils/ windows/ workers/ assets/
packages/
  shared/                    Cross-process types, constants, IPC channel names.
  mcp-trace/                 OpenTelemetry trace core with node and web adapters. Live feature.
docs/                        Internal documents (section 12). Not in the installer.
tools/                       Development tools: static checks, first-paint measurement, CDP smoke
                             test. Not in the installer.
scripts/                     Build, packaging, and i18n scripts.
tests/                       Unit-test setup and Playwright end-to-end specs.
patches/                     Dependency patches. Restricted zone.
```

Path aliases: `@main/*` → `src/main/*`, `@renderer/*` → `src/renderer/src/*`, `@shared/*` →
`packages/shared/*`, `@mcp-trace/*` → `packages/mcp-trace/*`, `@types` → `src/renderer/src/types/index.ts`,
`@logger` → LoggerService (one file for each process side).

Main entry chain: `src/main/index.ts` → `bootstrap.ts` → `kernel/index.ts` + `ipc.ts` →
`windowService.createMainWindow()`.

Renderer entry chain: `index.html` → `entryPoint.tsx` → `init.ts` → `App.tsx` → `Router.tsx`.

Three HTML entries exist: `index.html` (main window), `miniWindow.html` (quick assistant),
`traceWindow.html`.

Child processes:

| Process | Entry | Purpose |
|---|---|---|
| utility process | `out/main/localOcrWorker.js` | Local PaddleOCR inference. |
| utility process | `out/main/visionWorker.js` | Rasterization leg for vision-model document handling. |
| worker thread | `readableContentWorker` (`?nodeWorker`) | Plain-text extraction from a file. |

## 4. Setup

```powershell
$env:PATH = "F:\nodejs;" + $env:PATH   # Node 24.11.1 or newer. The DSH bundled Node is too old.
$env:CI = "true"                        # Stops pnpm from failing on a missing TTY.
```

Call the tools in `node_modules\.bin\` when `pnpm` cannot spawn a process: `tsgo`, `vitest`, `oxlint`,
`eslint`, `biome`, `electron-vite`. Only install and packaging need `pnpm`.

Dev server port: 5870. `DSH_DEV_PORT` overrides it.

## 5. Commands

| Task | Command |
|------|---------|
| Dev server | `pnpm dev` |
| Typecheck, main side | `tsgo --noEmit -p tsconfig.node.json --composite false` |
| Typecheck, renderer side | `tsgo --noEmit -p tsconfig.web.json --composite false` |
| Lint, fast | `oxlint --deny-warnings` |
| Lint, full | `eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts` |
| Format check | `biome format` and `biome lint` |
| Static checks | `node tools/static-checks/run-all.js` |
| Unit tests, all | `vitest run --silent` |
| Unit tests, selected | `vitest run --silent <file> ...` |
| Production build | `electron-vite build` |

Pass `--composite false` to `tsgo` always. Without it, tsgo reports false TS4023 and TS2742 errors.
It also writes about 2000 stray `.js` and `.d.ts` files into `src/`. Those files break Vite module
resolution.

The static suite finds the repository root from its own location. `RC_REPO` overrides that root.
The suite accepts `--only=<check>` and `--quiet`, and it prints the time of each check.

## 6. Quality gates

**Fast set, about 20 s.** Run it after each change:

1. `biome format` and `biome lint`.
2. `oxlint --deny-warnings`.
3. Both typechecks.
4. The static suite.
5. The tests of the files that you touched.

**Full set, about 4 min.** Run it before a commit that closes a work item, and when you touch shared
code (the kernel integration layer, `packages/shared/`, a build config):

1. The fast set.
2. `eslint`.
3. `vitest run --silent`.
4. `electron-vite build`.

Run the static suite after you delete, rename, or move a file. Run it also after you change an import
or export surface, an i18n key, or a build config (`package.json`, `pnpm-lock.yaml`,
`electron-builder.yml`, `patches/`, `tsconfig*`, `vitest.config.ts`).

Each gate covers a different area. Types cover the type graph. Lint covers style and local rules.
The static suite covers references, syntax, config, and i18n. Tests cover behavior. The build covers
bundling. A green gate does not prove behavior. A behavior change needs a behavior test, or a sample
from the dev instance.

Test rules:

- The unit tests use the forks pool. The threads pool crashes on this machine.
- Do not use timing as a regression signal. Use exit codes and test counts.
- Re-run a failed suite on an idle machine before you report a regression.

### 6.1 Delete rules

Before you delete a file or a symbol that looks unused, list all six consumption forms:

1. String literal.
2. Object value lookup. A key table stores the name.
3. Template literal.
4. Variable key table.
5. Barrel re-export.
6. Side-effect import.

Then confirm with two methods that do not share a blind spot. Example: search by alias and by relative
path. Search by type name and by value usage.

i18n is the usual trap. The main process reads some locale keys by object value. A literal scan cannot
find those readers.

A module is dead when its only reference is its own test file. Delete the module and the test together.
An export is not dead when an active module uses it, even when only a test imports it. Rollup removes
unused exports.

## 7. Kernel rules

These rules are hard. Do not break them.

1. **The kernel is a restricted zone.** Do not edit the `@deepseek-ai/*` packages in `node_modules`.
   Do not edit the files in `patches/`. Do not bypass the Cordis plugin lifecycle.
   Use the public seams only: `ctx.agents`, `ctx.sessionPersistence`, `ctx.llm.resolveModelInfo`,
   `ToolRuntime`, `session/event`, and the documented `llm/stream` waterfall.
   Send structural work through `ctx.topicTree`, `ctx.sessionGC`, and `ctx.reasoning`.
   Do not open the kernel SQLite outside the kernel. Do not rename a kernel session event.
2. **The kernel session log is the only source of truth.** The renderer projects that log.
   Every chat state must be recoverable by folding the log. Do not add a second source of truth.
   Do not let a wire-side transform touch the database.
3. **The kernel decides topic membership.** `dshTopicList` is authoritative. Only rows restored from an
   earlier session can be stale. Never revive a deleted topic id.
4. **`ensureAgent` must never create a session over an existing log.** `sessionResumeFallback.ts` makes
   that decision. It queries persistence for existence and fails closed. An error type is diagnostic only.
5. **Every kernel query tolerates the boot window.** Use `retryKernelQuery`. A definitive answer returns
   at once, including a negative answer. `undefined` means "retry later". Any other value, including
   `false` and empty, is final. `null` means "no answer". Only `false` may reject. `null` never
   justifies a refusal and never justifies hidden data.
6. **An unknowable state never authorizes a destructive action.** A failed registry read is not an
   absent registry. Skip the sweep and back up the file when a parse fails. Never treat "no answer" as
   "empty".
7. **The renderer holds no event-visibility predicate.** `sessionEventView.ts` is the only predicate.
   Apply it at all three exits: the live broadcast, `uiEvents`, and search. Solve visibility in the
   structure.
8. **Startup order is a safety property.** In `src/main/index.ts`, keep `registerShortcuts()` and
   `await registerIpc()` before the cosmetic initializers. Wrap each optional initializer in a
   log-only `try/catch`.
9. **Patch a kernel package only when no public seam reaches the problem.** Then add one `globalThis`
   gate line. The gate must be neutral: without the gate, the package behaves exactly like upstream.
   Send a response-side change through the `llm/stream` waterfall. Never patch for a cosmetic issue.
10. **Mark every custom session event with `ignorable: true`.** The mark is the only lever that this
    fork has. Without it, the kernel rejects the whole log of that session.
11. **A stop is topic-level, and it must cut the work in flight.** A kernel `topicTree.stop()` acts at a
    turn boundary only. Do not rely on it to interrupt a running model stream.
12. **The trace stack is live.** It includes `packages/mcp-trace/`, `NodeTraceService`,
    `SpanCacheService`, and the trace window. The package name is historical.

## 8. Data and state

| State | Location |
|-------|----------|
| Chat sessions | Kernel SQLite: `{userData}/kernel/sessions.db` |
| Topic registry | `{userData}/kernel/topics.json` |
| Provider routes | `{userData}/kernel/settings.json`. Rebuildable. |
| Provider keys | `{userData}/provider-keys.json`, encrypted by `ProviderKeyStore` |
| Files, note index, phrases, translations, paintings, usage | Dexie tables in `src/renderer/src/databases/index.ts` |
| Note bodies | Plain files under `{userData}/Data/Notes/*.md` |
| UI state | Redux slices, persisted with redux-persist |

Rules for persisted state:

- A new field in a persisted slice needs a migrate branch. `initialState` never reaches an existing
  user, because redux-persist replaces the whole slice.
- Never delete a migrate branch. Keep `version` in `store/index.ts` equal to the highest key in
  `store/migrate.ts`.
- `blacklist` in the persist config means "do not write to localStorage". It does not mean "unused".
- A store that reads `app.getPath()` must construct lazily. The bundler decides module order, not the
  source order.
- The persist transform strips every non-empty `apiKey` before the write. Keep that behavior.
- A decrypt failure means "no key". Never add a plaintext fallback.

Renderer rows are derived data. A message, a message block, and a citation carrier come from the kernel
log, so a change to their shape needs no data migration.

## 9. IPC contract

Three layers must stay in step:

1. Channel names in `packages/shared/IpcChannel.ts`.
2. Handlers in `src/main/ipc.ts` and `src/main/kernel/index.ts`.
3. The bridge in `src/preload/index.ts`.

Update all three layers in one change. Validate all IPC input in the main handler. Never expose a Node
API to the renderer.

Keep a kernel channel handler thin. Shape the arguments, register the work, and return. Do not do the
work in the handler.

A stop is topic-level. `dsh:topic-stop` aborts the long work that the topic registered, then lets the
kernel finish the turn. Do not stop by message id.

The static suite does not cross-check the three layers. Check a new channel by hand: the name is
declared, the main process registers it, preload exposes it, and the renderer calls it.

## 10. Coding rules

### Failure semantics

- A failure must never look like an empty result. A failed fetch rejects. It never renders a partial or
  fake result.
- Never fail silently. Log the failure and show a user-visible signal. Do this also for a
  fire-and-forget write.
- A deletion returns `Promise<boolean>`. Restore the optimistic rows on failure and show `toast.error`.
- A batch deletion reports "N succeeded / M failed" as a real signal.
- An empty extraction result returns a neutral one-line note as a normal tool result. It is not an error.

### Logging

- Use `loggerService.withContext('Module')`. Never use `console.log`.
- A renderer `info` log does not reach the disk. Use `warn` for a forensic hook, or the diagnostics
  switch.

### i18n

- Ship two locales only: `zh-CN` and `en-US`.
- Put every user-visible string through i18next. Keep a feature namespace at the top level. The key gate
  cannot see a nested key.
- Use `defaultValue` for a missing-key fallback. `t('k') || 'fallback'` never runs, because i18next
  returns the key itself.
- Prefer an explicit `Record` map over a template key. The compiler then checks exhaustiveness.
  Register a template key in `tools/static-checks/i18n-dynamic-registry.json` only when it is truly
  dynamic.
- Prune an orphan key only through the delete rules in section 6.1. Then run the static suite. The suite
  turns red when a deleted key is still in use.

### Text style

- Write tool-injection text in ASD-STE100 style: a tool description, a parameter description, and
  context-snapshot text. Use short sentences and the active voice. Give one instruction per sentence.
  Do not praise the implementation. Do not list a provider or a config value that the runtime resolves.
  Do not repeat what the context snapshot already carries.
- Write in-app UI description text in ASD-STE100 style as far as the wording allows.
- Quote a file or document name in a context list. Such names contain spaces and mixed scripts.

### Rendering

- Pass an explicit `status` to every `createXxxBlock` call.
- Show a skeleton or a placeholder for every state, and for a block that has no address. Silent
  invisibility is the worst failure mode.
- For a container with `overflow` and `max-height`, declare both axes. Add `overflow-x: hidden` and
  `scrollbar-gutter: stable`. Without them, a width-reflow-height loop can start.
- A UI interaction change needs behavior-level proof. Show a sample from the dev instance, or add a
  behavior test. A static argument about blast radius is not proof.

### Subprocess and native code

- In an Electron utility worker, read `process.parentPort`. The `.d.ts` export is wrong. A worker-side
  message arrives as a `MessageEvent`. Read `.data`. A main-side `utilityProcess` message is a bare
  value.
- Wire a forked main-process child with `stdio: 'pipe'` into the logger. Then a crash stays available.
- On Windows, `env.PATH` is case-sensitive on a plain object. Normalize it. Use the `withPathPrepend`
  pattern.
- Match the command line exactly before you kill a process. List first, then kill. The Electron app,
  the agent hosts, and the targets can all be `node.exe`.

### Build and config

- `electron.vite.config.ts` externalizes all `dependencies`. Anything that the main process `require`s
  at runtime stays there. A removal breaks at runtime, not at build time.
- Keep the pnpm config (`overrides`, `patchedDependencies`, `onlyBuiltDependencies`) in
  `pnpm-workspace.yaml`.
- Declare a runtime-needed peer-only package in the root manifest.
  `check-package-runtime-closure` guards this.
- Keep the `cherrystudio://` protocol, the backup default filename, and the third-party app ids. These
  names are locked.
- The renderer splits by route. `Router.tsx` imports the home page statically and lazy-loads the other
  pages. Keep the Suspense fallback. Do not load a heavy library on the first paint.

### Packaging

- electron-builder cannot see the `optionalDependencies` of a top-level-resolvable package. Declare a
  runtime platform binary as a root `optionalDependency`. Add an `asarUnpack` entry for the native
  closure.
- `scripts/after-pack.js` asserts that the unpacked natives exist. Keep that assertion.

## 11. Release process

1. Run the full gate set on a clean tree.
2. Bump `version` in `package.json`.
3. Insert the new version block in `releaseInfo.releaseNotes` of `electron-builder.yml`. Keep the older
   blocks below it. Use the `<!--LANG:en-->`, `<!--LANG:zh-CN-->`, and `<!--LANG:END-->` markers.
4. Commit.
5. Tag the commit: `git tag -a v<version> -m '<title>'`.
6. Package when the release needs artifacts: `pnpm build:win:x64 --publish never`. The `--publish never`
   flag is mandatory. In CI mode, electron-builder tries a GitHub publish and fails.
7. Verify the package before you ship it. Start it, open the chat page, and open a lazy route.

## 12. Documents in this repository

`docs/` holds the internal documents. They are not part of the installer.

| Document | Content |
|---|---|
| `docs/architecture.md` | Process model, directory map, chat data flow, build output. |
| `docs/kernel-integration.md` | Public seams, fork modules, patch policy, start order, stop chain. |
| `docs/data-and-state.md` | `userData` layout, renderer persistence, secrets, logs. |
| `docs/ipc-contract.md` | The three IPC layers, channel groups, kernel channel conventions. |
| `docs/quality-gates.md` | Each gate, its coverage, its measured cost, and the test rules. |
| `docs/release-process.md` | Version, tag, release notes, packaging contract, smoke test. |
| `docs/limits-and-baseline.md` | Deliberate limits, known behavior boundaries, open item, first-paint baseline. |
