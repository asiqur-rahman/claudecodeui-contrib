# Adversarial Architecture Review — Command Code Provider Spine

**Artifact under attack:** `ARCHITECTURE-SPINE.md` (2026-09-03, status: final)
**Review method:** For each AD, construct TWO implementing units one level down that each
obey the AD's letter, yet build INCOMPATIBLY. Ground every construction in the actual
brownfield code (verified against this checkout, not just the spine's prose).
**Verdict:** **FAIL** — two units were found whose divergence AD-9/AD-3 cannot stop because
the ADs delegate the divergent decision to unspecified templates, and a fourth shows an AD
whose "fix" clause would be actively harmful if followed.

---

## Method note (evidence base)

- Backend ground truth consulted: `provider.registry.ts`, `provider.routes.ts`,
  `provider-capabilities.service.ts`, `provider-runtime.service.ts`, `sessions.service.ts`,
  `session-synchronizer.service.ts`, `sessions-watcher.service.ts`,
  `chat-run-registry.service.ts`, `chat-websocket.service.ts`, `shell-websocket.service.ts`,
  `agent.routes.ts`, `commands.routes.ts`, `session-conversations-search.service.ts`,
  `provider-models.service.ts`, `database/schema.ts`, `database/migrations.ts`,
  `database/repositories/sessions.db.ts`, claude/codex/opencode provider folders,
  `server/shared/{types,interfaces,utils}.ts`.
- Frontend ground truth: `src/shared/types.ts`, `src/shared/constants.ts`,
  `src/shared/selectedProvider.ts`, `useChatProviderState.ts`, `useChatMessages.ts`,
  `useChatRealtimeHandlers.ts`, chat transcript components.
- On-disk Command Code artifacts (the repo's own `.commandcode/` live files) were read to
  verify the session store shape: header + flat message list with `parentId` tree links,
  no rewind/fork rows, title only in `.meta.json`.

---

## Pair A — Result-line session capture vs. claude-style transcription (AD-6 / AD-3). **Unit A1 does, Unit A2 does, and they collide mid-run.**

Both units believe they are faithfully implementing AD-6 ("capture `sessionId` from the
result line") and AD-3 ("model sessions/synchronizer on the **claude** provider (… sidecar
`.meta.json`)").

**Shared premise (unstated by the spine):** claude-style synchronization only ever sees a
file whose rows are already tagged with the session id. In the claude adapter the first row
of every file is `{type:"summary", sessionId: <id>, cwd}` and **every** transcript row
carries `sessionId` (`readTranscriptRows` filters `entry.sessionId === providerSessionId`;
the claude synchronizer's `processSessionFile` parses top-level `data.sessionId`). The
synchronizer then inserts a row whose app `session_id` **equals** the file's native id and
whose `jsonl_path` points at that exact file.

**Unit A1 — claude-model synchronizer + ** on-arrival** writer:**
- `command-code-session-synchronizer.provider.ts` parses the on-disk transcript's **first
  line**, `{"type":"session","version":3,"id":"<uuid>","cwd":"D:\\RnD\\..."}`, takes
  `id` as `sessionId` and `cwd` as `projectPath`, calls
  `sessionsDb.createSession(nativeId, 'command-code', cwd, name, ..., filePath)` → app id ==
  native id.
- The runtime captures the native id from the NDJSON **result line** (`sessionId` field) and
  calls `ws.setSessionId(nativeId)` **only after the run finishes** (the result line is the
  *final* line of the stream).
- Before that final line, the runtime emits normalized message events; the writer labels them
  with the app id passed in. On a brand-new UI session the row was created with
  `provider_session_id = NULL` and `jsonl_path = NULL` (app-created row), and `fetchHistory`
  refuses to read (requires `provider_session_id`). The transcript file only appears when the
  run exits.

**Unit A2 — codex-model synchronizer + ** mid-stream** capture:**
- The synchronizer parses the first line the same way (same file format — AD-3's real store
  has no per-row `sessionId` on message rows, so A2 also reads the header). Same DB insert.
- The runtime mirrors the **codex** template instead: it captures the native session id from
  the stream *as soon as it is observable* and immediately calls `ws.setSessionId(id)` +
  emits a `session_created` event with `newSessionId`, then **emits message events with the
  provider-native id** (codex template sends normalized messages labeled with
  `capturedSessionId || sessionId` from the moment of capture).

**Incompatibility (both obey every AD to the letter):**
- A1's transcription bug: an app session that is *still running* has no row mapping and no
  transcript path, so `chat.run` history refetch after `complete` lands before the
  synchronizer's chokidar `add` event and `broadcastSessionUpserted` — it returns an empty
  transcript for up to a debounce+scan cycle. A1 makes `setSessionId` a run-end action, so
  there is a real window where the sidebar and history disagree.
- A2's corruption bug: `chat-run-registry.service.ts` remaps *every* outbound event's
  `sessionId` to the **app** id at the writer boundary, and on `complete` overwrites
  `actualSessionId` with the app id; but the runtime also labeled its own pre-writer events
  `session_created` with the native id. The `recordProviderSessionId` handler fires on the
  writer (`setSessionId`), **and** `sessionsDb.assignProviderSessionId(appId, nativeId)`
  **merges** the synchronizer-created duplicate row — which is the row whose `jsonl_path`
  points at the transcript. Meanwhile the A2 synchronizer, on the watcher `add` of the same
  file, already called `createSession(nativeId, …)`, and — because the app row did not exist
  yet or the merge raced — a **second** row keyed by the native id exists until the merge,
  exactly the transient duplicate sidebar entry the mapping code exists to prevent.
- The two disagree about whether the file on disk is even complete when it is indexed: A1
  indexes it on `change` events as rows stream; A2 indexes it on `add` and relies on the
  writer. The resulting DB state for the *same* CLI run differs by which unit built it.

**Why the ADs fail to stop it:** AD-6 fixes the *CLI-facing* grammar (spawn argv, NDJSON
frame shapes, exit-code table) and asserts "capture `sessionId` from the result line" — a
clause that literally *pulls* the A1 behavior (capture at the end) even though only A2's
mid-stream capture keeps the UI consistent. AD-3's rule ("model the synchronizer/sessions
facets on the **claude** provider… and the codex provider (headless NDJSON history)") tells
two implementers to model the *same two facets* on *two different providers* whose
session-id handshake and row-keying behavior are **mutually exclusive** in this codebase
(claude: disk keyed by in-file id, history read from `jsonl_path`; codex: app/native mapping
written by the registry from a mid-stream capture, synchronizer looks up the pending app row
and even calls `assignProviderSessionId` itself — opencode does too, at
`opencode-session-synchronizer.provider.ts:116-125`). The spine never states *who* claims the
native id (writer vs. synchronizer), *when* (mid-stream vs. run-end), or whether the
synchronizer must prefer an existing pending app row — the exact predicates the existing
codex/opencode adapters had to add. AD-3 and AD-6 therefore license two different, and
colliding, DB claim orders.

**Fix direction:** make it an AD: "the **runtime** (via `ws.setSessionId` /
`session_created`) is the sole owner of the app↔native mapping and must claim it the moment
the first streamed event discloses the native id; the **synchronizer** must resolve a
pending app session (`findLatestPendingAppSession(provider, cwd)` like opencode) and must
never insert a native-keyed row when a pending app row exists; transcription of live
message rows into the file is not a prerequisite for sidebar membership." One sentence kills
both A1 and A2.

---

## Pair B — The JSONL "tree" reader (AD-3's claude model vs. the codex NDJSON reader). Both units read "the active branch"; they return different transcripts.

**Shared premise:** AD-3 binds `command-code-sessions.provider.ts` (`fetchHistory`) to
"the claude provider (per-file JSONL …)" and AD-6's consistency table says the sessions
facet reads the **JSONL tree / active branch** ("Deferred" section). Claude's actual reader
(`readTranscriptRows`, `dropSupersededPromptBranches`, parentUuid graph) exists for one
reason: a claude transcript is an *append-only log of edits*, in which a **message edit
re-writes the file with a second path** sharing parents, and the active conversation is the
*last path* in that graph. That machinery is real and specific.

**Unit B1 — claude-tree reader:** implements `getCommandCodeSessionMessages` exactly as
claude's: `readTranscriptRows(jsonlPath)` returns only rows whose top-level `sessionId`
matches `providerSessionId`; superseded sibling **prompts** (same `parentId`, later
sibling wins) are pruned by graph walk; returns "the active branch" = last sibling chain.

**Unit B2 — codex-NDJSON reader:** implements the facet as the codex adapter does: the codex
reader performs a *linear, chronological replay* of the whole file with a per-line state
machine (`entry.type` + `payload.type`, `event_msg`/`response_item`, ordering by timestamp,
rollback tracking for `thread_rolled_back`), because a codex rollout is a *linear event log
of one thread*.

**Verified incompatibility on real Command Code files:** the actual on-disk transcript is a
**linear append-only message list** — header row then `{"type":"message","id","parentId",…}`
rows. There are **no** `rewind`/`fork`/rollback row kinds and **no per-row `sessionId`**
(only the header carries the id). So:
- B1, when it obeys the claude model faithfully, drops the *entire transcript*: `entry.sessionId`
  is `undefined` on every message row, so `readTranscriptRows` yields zero rows — or the unit
  "fixes" it by keying on the header id and then *also* implements sibling-prompt pruning,
  which is **wrong for this store**: a Command Code user message legitimately answers a
  parent message with `parentId` of an assistant row; sibling detection keyed on `parentId`
  of *prompts* is meaningless here because prompts in this format are not the only writers
  under a shared parent (tool_result continuations are separate rows). Real edits **do**
  produce two user rows sharing one `parentId`; B1 deletes the *older* one. That is
  transcript deletion, not branching.
- B2's linear replay has no notion of the parentId tree at all, so on a genuine
  `/fork`+resume it returns the pre-fork *and* post-fork turns stacked as one conversation
  (exactly what claude's graph read exists to prevent), and — because Command Code rows are
  not codex rows — B2 has to invent a state machine for `tool_result`-style rows that the
  actual format never produces.

**Why the ADs fail to stop it:** AD-3's claude/codex bicast is *load-bearing but
self-contradictory for the one thing that differs*: claude's reader logic exists to handle a
tree/edits format; codex's exists to handle a linear log. Command Code's real format is a
third thing — a *linear file whose rows carry parentId but whose file never rewinds*. The
spine names claude as the template *for the file layout* and codex *for the NDJSON history*,
and then says nothing about which row semantics (graph-prune vs. linear-replay) apply. AD-3
therefore permits B1 (drop everything) and B2 (stack forks) simultaneously; both are "modeled
on" exactly the templates the AD names. The "active-branch" phrase in the Deferred section is
the only nod to the tree, and it is not bound to any facet rule.

**Fix direction:** bind one concrete grammar: "(1) rows are `{type:'message', id, parentId}`
on a flat append-only file; (2) the active branch is **the longest chain following
`parentId` from the last row**, preferring later siblings — a *linearization*, never a
graph prune of older prompts; (3) row identity for anchors is the row `id`, which is stable
across reads; (4) `sessionId` exists only in the header and must not be required per row."
That single paragraph converts the divergence into a testable contract.

---

## Pair C — Exit-8 / permission-mode / capability flags: the runtime maps them one way, the backend capability matrix and the frontend fallback matrix map them another (AD-6 vs. AD-9). **C1 runs turns the CLI rejects; C2 renders controls whose turns never reach the CLI.**

**Shared premise:** `chat.send` carries a `permissionMode` from the composer, and the
frontend capability consumers (`useChatProviderState.ts`, plus the constant maps in
`constants.ts` — MCP transports/scopes) keep **static per-provider fallback matrices** that
render before `GET /api/providers/capabilities` resolves. The backend matrix is
`provider-capabilities.service.ts`; the frontend union and fallback lists are duplicated in
`src/shared/types.ts` (`PermissionMode`) and the `Record<LLMProvider, …>` tables.

**Unit C1 — runtime-first mapper:** `command-code-runtime.provider.js` maps the UI modes to
the CLI's real `--permission-mode` vocabulary (`default|plan|auto-accept|dont-ask` from the
requirements table; the spine's own consistency table says "permission modes match the
option sets accepted by each CLI"). AD-6 names the flags `--permission-mode`, `--max-turns`.

**Unit C2 — capability-matrix-first builder:** `provider-capabilities.service.ts` entry sets
`permissionModes` to the values the UI can already type (the frontend `PermissionMode` union
is `'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'`; the codex fallback
column is a 3-mode subset; `MessageComponent`/`ComposerPermissionMenu` and the chat
transcript render from that union). To "appear like the others", C2 publishes
`['default','acceptEdits','bypassPermissions','plan']` and — for the token-usage row the
capability matrix demands — implements a fake `supportsTokenUsage` by re-parsing the JSONL
when no CLI `result` line survives.

**Collision:** C1 has to translate the UI's `acceptEdits`/`bypassPermissions` into the CLI's
`auto-accept`/`dont-ask`; C2 has no translator because it believes the UI values *are* the
CLI values (every existing provider's matrix matches its runtime's flags 1:1 — claude,
codex, opencode all do). Neither the AD-9 rule ("set `permissionModes` etc. to Command
Code's real `--permission-mode` set") nor AD-6 (which says the runtime accepts
`--permission-mode`) states that the **frontend union is not extensible by a backend
string**, so the two units jointly produce either (a) a picker offering `acceptEdits` that
C1 translates to `auto-accept` and the CLI honors — silently lying about what the user
selected — or (b) a picker offering the CLI's true `dont-ask` value that the frontend's
`PermissionMode`-typed state and every existing mode-conditional in the transcript renderers
cannot represent, so the composer writes it, `useChatProviderState` drops it back to
`default`, and the turn runs un-requested. Same for `supportsTokenUsage` (AD-6's result-line
`usage` is *only* on the final NDJSON line; a JSONL-reparse implementation differs in what
"used" means), and for **effort**: C2 inherits `supportsEffort:true` from the opencode
template, but the Command Code effort vocabulary is `low|medium|high|…` while
`FALLBACK_PROVIDER_EFFORT_VALUES` keys on those strings per provider — C1's `--effort` arg
validation in the runtime will reject a value the matrix advertised.

**Exit-8, same shape:** AD-6 says exit 8 is "max-turns — surface, not error". "Surface" is
not pinned to any existing signal. The whole repo only ever marks a run over the wire with
`complete{exitCode, success, aborted}` (server `createCompleteMessage`) and the frontend
derives success/failure/abort from exactly those three booleans; there is no "stopped at
limit" channel (useChatRealtimeHandlers only special-cases `aborted`). Unit C1a surfaces
exit 8 by emitting `complete{exitCode:8, success:false}` plus a mid-run `error` message (the
codex/opencode pattern for nonzero exits). Unit C1b — equally AD-compliant — emits
`complete{exitCode:0}` and a `status` message so "not an error" is honored literally
(exit-8 is non-error, so success stays true per `createCompleteMessage`: `success = exitCode
=== 0`). The two produce opposite UI outcomes for the identical run; the AD cannot arbitrate
because "surface, not error" is underspecified against the *only* three fields the frontend
understands.

**Why the ADs fail to stop it:** AD-9's capability rule gestures at the real CLI set but
never says what happens when that set collides with the **shared `PermissionMode` union and
the frontend's static fallback matrices** — which are files the AD itself lists as must-edit
sites, without specifying whether they become a *superset*, a *translation layer*, or a
restriction. AD-6's exit table is a mapping table with no statement of which wire field
carries "max turns" and no acknowledgement that `success` is derived from `exitCode===0` at
a shared helper — making exit-8 *necessarily* an error under the existing contract unless
the runtime overrides `success`, which the AD does not permit or forbid.

**Fix direction:** (a) resolve the permission vocabulary conflict in one place, e.g. an AD
"the capability matrix publishes values in the frontend `PermissionMode` union and the
runtime owns the only translation table to the CLI's `--permission-mode` vocabulary — a
translation that may map two UI values onto one CLI value only when the CLI cannot
distinguish them, and the UI labels must then say so"; (b) extend the shared complete
contract with a typed `stopReason: 'max_turns'` (or pin "surface" to a `status` message +
`complete{exitCode:8, success:true}`) so both builders serialize identically; (c) pin the
effort-values matrix and `supportsTokenUsage` semantics to the runtime's actual parser.

---

## Pair D — The synchronizer rescans `change` events and re-inserts during live runs; delete-by-path and repoint race it. Two owners of one row (AD-3 / AD-9 watcher clause).

**Shared premise:** AD-9 requires adding the watch path and `*.jsonl` target predicate to
`sessions-watcher.service.ts`, and AD-3 requires the synchronizer to scan the same tree.
Existing adapters are pure upserts via `sessionsDb.createSession` — the ONLY writer of
`provider_session_id`/`jsonl_path` for disk sessions, and the ONLY readers of
`superseded_provider_sessions`.

**Unit D1 — claude-faithful synchronizer:** `createSession(nativeId, …, filePath)` on every
`add` and `change`, exactly like claude's (which rewrites `jsonl_path`, `updated_at`,
project_path on every event, and — because rows are appended while a run is live — re-inserts
mid-run with a *growing* file). Under this unit, a `command-code` run in a *second* tab of
the same project appends rows to the same file while the app's own runtime is streaming that
file into the DB via the **runtime-side** session-id claim of Pair A; `createSession`
upserts over the row the runtime just created (claude does the same when its own CLI writes
concurrently — tolerated because claude rows carry sessionId and claude never runs a second
live headless writer against the same file).

**Unit D2 — codex/open-code-faithful synchronizer:** mirrors codex, which *also* has to skip
rows its own runtime is currently creating — codex's watcher ignore list and the codex
`createCodexTurnTracker` skip/merge logic exist for exactly this reason, and opencode's
synchronizer first resolves the pending app row. Neither claude's nor codex's is correct for
a *file that is being appended to by a run this app itself launched headlessly while the
sidebar also streams the same conversation through the websocket*.

**Incompatibility:** the two implementations decide differently whether the *file watcher*
(the `change` event that fires as the runtime streams rows into the JSONL mid-run) should
re-run `createSession` while the run is live — D1 re-inserts and touches `updated_at` on
every append (the sidebar shows a session "bumping" while it is streaming; on app-delete of
that session, `deleteOrArchiveSessionById` force-delete unlinks the file that the live
runtime is still appending to), D2 refuses to touch a row the registry owns. Which behavior
is right is precisely what the ADs never say: AD-3 binds the synchronizer to claude (re-insert
blindly), AD-9's watcher clause binds it to the opencode/codex family (resolve pending row
first, suppress). The spine's table even calls delete "per-session deletable" (AD-3) without
noting that a headless `-p` run appends to the same file the delete path unlinks, or that a
fork (if ever added) writes a new file that the watcher would index as an unrelated session
before `createForkedSession` replaces it — the DB layer already contains the exact
transactional dance (`createForkedSession`'s delete+insert, `assignProviderSessionId`'s
merge) that only works if the synchronizer *never* inserts a native-keyed row for a file the
app is about to claim.

**Why the ADs fail to stop it:** ownership ("who may insert a row keyed by a provider
native id, and when") is never assigned. AD-3 gives the synchronizer the disk scan and the
runtime the session-id capture, but the DB row is one entity; both facets write it through
the same `createSession`/`assignProviderSessionId` repository, and the existing adapters
show three different ownership answers (claude: synchronizer only; codex/opencode:
synchronizer defers to the pending app row and the runtime claims it). AD-10 ("CHECK
changes via migration only") is the only AD with a crisp *who*, and it is about the wrong
table (the `provider_models` CHECK, not the sessions row lifecycle).

**Fix direction:** an AD that is explicit: "the session row for an app-launched run is owned
by the runtime claim (`assignProviderSessionId`); the synchronizer may only insert when no
row and no pending app session exists for `(cwd, provider)`; the watcher must not re-upsert a
row whose `jsonl_path` belongs to a currently-running app session (`chatRunRegistry`) and
must treat `change` on a live transcript as a non-event." Additionally pin delete-vs-live-run
semantics for per-session deletion.

---

## Pair E — Windows/POSIX divergence AD-2/AD-3 do not close. Two spawners, both compliant.

**Shared premise:** AD-2 (spawn `command-code` via cross-spawn everywhere, no `cmdc`
special-case) and AD-3 (files live at `~/.commandcode/projects/<slug>`) both claim to be
cross-platform rules.

**Unit E1 — prompt-as-argv spawner:** mirrors the opencode runtime exactly, argv-form:
`command-code -p <prompt> --output-format json …`. On Windows the npm shim is
`command-code.ps1` / `command-code.cmd`, so cross-spawn must resolve the `.cmd`, and the
*entire prompt travels as one argv element through cmd.exe* — the repo already had to invent
`flattenPromptForWindowsShell` because cmd truncates argv at the first newline, and its
opencode adapter additionally forces `--dir`. Nothing in AD-2/AD-6 says to flatten newlines
or pass a working directory flag, so E1 on Windows silently truncates any multi-line prompt.

**Unit E2 — prompt-on-stdin spawner:** the opencode `run`/claude conventions differ on how
the prompt reaches the CLI; E2 chooses the codex route (prompt via argument) *plus* the
claude route (prompt via stdin) depending on which template line it reads, and on Windows
quotes `--resume "<id>"` because `resolveResumeSessionId` in the shell PTY layer already
quotes resumes for other providers (see `shell-websocket.service.ts` `buildShellCommand`:
`--resume="…"`). A Command Code resume id is a UUID; claude/codex ids may contain `:` etc.,
but the SAFE patterns differ (`SAFE_SESSION_ID_PATTERN` in shell service allows `:`;
`parseSessionId` in the routes allows `._-` only). E2 double-quotes, E1 does not; under
cmd.exe the quoting changes what the CLI receives (embedded `"` breaks the resume id).

**Where it bites:** the auth probe (AD-4) is a second, un-bound spawn site (`status --json`);
the spine's own evidence table shows the *binary is `cmdc` on Windows* and npm ships
`command-code.ps1` shims; the repo's only cross-platform spawn discipline lives inside
adapters that each solved argv/stdin/cwd/quoting differently. AD-2's "always `command-code`,
never `cmdc`" does not state *how the prompt and flags are transported* (argv vs stdin vs
both), *whether prompts must be newline-flattened on win32*, or *which quoting rule applies
to `--resume <id>`*, so E1 and E2 remain jointly AD-compliant while one truncates prompts
and the other mangles resume ids on the same platform. The same gap applies to `.cmd`
resolution for the *auth* facet's `status --json` and the *skills* facet, none of which
AD-2's "binds:" line covers (it names only the runtime and the auth probe — and then only
the spawn target, not transport/quoting).

**Fix direction:** extend AD-2 to bind the transport contract: "the prompt and all flags are
passed as a single argv array through cross-spawn; on win32 the prompt is newline-flattened
(reuse `flattenPromptForWindowsShell`) and `--resume`/`--session` values are passed
unquoted as separate argv entries; a working directory is always selected by an explicit
`cwd` and, where the CLI owns workspace resolution, by an explicit directory flag (mirror
opencode `--dir`)."

---

## Pair F — Frontend/backend union drift that AD-9 cannot close (capability matrix vs. static frontend lists).

**Shared premise:** the frontend duplicates the provider enum into several independent
`Record<LLMProvider, …>` tables that must be extended by hand:
`src/shared/types.ts:8`, `selectedProvider.ts:19` (`PROVIDERS` const),
`useChatProviderState.ts` (`FALLBACK_DEFAULT_MODEL`, `FALLBACK_PERMISSION_MODES`,
`FALLBACK_PROVIDER_EFFORT_VALUES`, `PROVIDERS`), `constants.ts` (`MCP_PROVIDER_NAMES`,
`MCP_SUPPORTED_SCOPES`, `MCP_SUPPORTED_TRANSPORTS`, `MCP_SUPPORTS_WORKING_DIRECTORY`,
`PROVIDER_PERMISSION_PREFERENCE_KEYS`), plus the backend's `provider.registry.ts`,
`provider.routes.ts` `parseProvider`, `session-synchronizer.service.ts`
`processedByProvider` counter, `sessions-watcher.service.ts` watch list, `commands.routes.ts`
`MODEL_PROVIDERS`, `agent.routes.ts` guard (`['claude','cursor','codex','opencode'].includes`),
`notification-orchestrator.service.js` `PROVIDER_LABELS`, and the migration CHECK.

**Unit F1 — backend-first:** adds `command-code` to the backend registry/routes/capabilities
and extends both `LLMProvider` unions, then waits for the frontend PR.
**Unit F2 — frontend-first:** extends every frontend `Record`/`PROVIDERS` const and the MCP
per-provider scope/transport matrices, and ships the capability-driven picker.

**Collision:** neither can make the other's half type-check or behave; worse, two specific
*semantic* duplications exist that no type union catches: (1) `MCP_SUPPORTED_SCOPES` /
`MCP_SUPPORTED_TRANSPORTS` per-provider maps in `constants.ts` are read by the UI *before*
the capability matrix arrives, and the backend `provider-capabilities.service.ts` has no
scope/transport fields at all — Command Code's real scope `local` + transports `http`,`sse`
must be mirrored in *both* the frontend map and the backend `parseMcpScope`/`parseMcpTransport`
allow-lists, and nothing shared forces them to agree. A unit that adds `command-code` to the
backend MCP routes but forgets `src/shared/constants.ts` renders an MCP panel that cannot
represent Command Code's `local` scope — silently (the type union passes because
`McpProvider = LLMProvider` and the map is typed `Record<McpProvider, string[]>`, so a
missing key is a runtime `undefined`, not a compile error, when the capability payload is
keyed by provider). (2) The backend `parseProvider` and `agent.routes.ts` guard are
hand-written string allow-lists that are NOT derived from the union; F1 extending the union
does not extend the guards, so `GET /api/providers/command-code/models` 400s while the
frontend picker offers it.

**Why the ADs fail to stop it:** AD-9 is a checklist, not a constraint. It enumerates the
files (which is genuinely useful) but contains no mechanism — no shared constant consumed by
both allow-lists and matrices, no type-level test — that makes "add the id in every listed
site" *enforceable* or even *detectable* when one site is missed; the frontend's duplicate
tables and the backend's string allow-lists remain free to disagree, and the AD's "capability
matrix drives UI behavior" sentence is contradicted by the frontend's own static fallbacks
that render first. This is the weakest AD of the eleven: every *other* AD pins an actual
semantic, AD-9 pins only a shopping list. AD-11 (narrow subsets) is a second, smaller
instance of the same weakness — "leave command-code out unless a story widens it" for search
is fine, but its own list includes `PROVIDER_LABELS` where it demands the opposite, and the
AD cannot tell the implementer which of the two rules wins for a map that is neither
deliberately narrow nor complete (notifications currently omit even opencode).

**Fix direction:** promote AD-9 from checklist to constraint: derive the route `parseProvider`
allow-list and the frontend provider lists from a single exported `PROVIDER_IDS`/registry
source (server: registry keys; frontend: one shared array imported by all `Record` maps so
the type system reports an incomplete record), and add a compile-time `satisfies Record<LLMProvider,…>`
discipline plus a route-level integration test asserting `GET /capabilities` contains every
`LLMProvider` and every provider id in `parseProvider`. That converts "forgot a site" from a
silent runtime gap into a compile error / failing test.

---

## AD-strength audit (question 6)

| AD | Verdict | Why |
| --- | --- | --- |
| AD-1 | Strong | Single literal; both type unions + registry + DB CHECK are named; a second alias is a compile error. |
| AD-2 | Weak on transport | Binds only *which binary*; silent on argv-vs-stdin, newline flattening, `--resume` quoting, cwd flags, and auth-probe transport (Pair E). |
| AD-3 | **Weakest semantic anchor** | "Model on claude … and on codex" names two mutually incompatible templates for the same two facets, and never states the actual row grammar, the ownership of the app↔native mapping, or who claims it when (Pairs A, B, D). |
| AD-4 | Strong | Single command, defined exit semantics, ENOENT-as-data; the one gap (how to spawn on Windows) is covered by AD-2's weakness. |
| AD-5 | Mostly strong | Curated catalog is unambiguous; "active model from disk" falls into Pair B's format ambiguity (which disk file, which row), so the *source* is under-specified. |
| AD-6 | Medium | Pins argv/NDJSON/exit codes well, but "capture sessionId from the result line" conflicts with the runtime's need to claim the id mid-stream; "surface, not error" for exit 8 is unpinned against the only three wire fields (`exitCode/success/aborted`) the frontend understands (Pairs A, C). |
| AD-7 | Strong | Concrete roots, prefix, precedence, write target. |
| AD-8 | Strong | Shape + scopes + transports named; claude-mcp is the single closest template. |
| AD-9 | **Checklist, not a constraint** | Enumeration is useful; there is no mechanism forcing the listed sites to agree, and the static frontend fallback matrices are *expected* to be hand-mirrored (Pair F). The capability-matrix rule is contradicted by the frontend's own pre-matrix fallbacks. |
| AD-10 | Strong on its one claim | Migration-only is clear and correct — but it governs only the `provider_models` CHECK; the sessions-table lifecycle (Pair D) has no analogous ownership AD. |
| AD-11 | Weak | "Deliberate subsets are deliberate" cannot arbitrate a map that is *neither* deliberately narrow *nor* complete; the rule text itself contradicts (search narrow vs. labels complete). |

## Verdict

**FAIL.** Two constructed unit pairs are jointly AD-compliant yet build incompatible systems
with real user-visible breakage (A: session claim timing → empty history / duplicate sidebar
rows mid-run; B: active-branch read → dropped transcripts or stacked forks; C: permission
vocabulary + exit-8 → UI modes the CLI rejects or CLI modes the UI cannot hold; D: two
owners of one session row → delete/live-run and fork races). The two ADs doing the least
work are AD-3 (contradictory bicast) and AD-9 (uncheckable checklist); AD-6's "capture from
the result line" and "surface, not error" actively push Pair A/C builders toward the broken
implementations. AD-1, AD-4, AD-7, AD-8, AD-10 survive adversarial construction.
