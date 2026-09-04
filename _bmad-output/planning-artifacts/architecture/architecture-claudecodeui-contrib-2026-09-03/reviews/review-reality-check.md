# Reality-Check Review — command-code-provider Architecture Spine

**Reviewer:** Adversarial architecture reviewer (reality-check lens)
**Review date:** 2026-09-04
**Target:** `ARCHITECTURE-SPINE.md` (AD-1..AD-11, Stack, Deferred, memlog)
**Method:** Cross-checked every committed decision against (a) the live `command-code` v1.45.0 binary on this host, (b) current https://commandcode.ai/docs pages (CLI Reference, Headless, Sessions & Checkpoints, Skills, MCP), (c) live artifacts under `C:\Users\asiqu\.commandcode\` (auth.json, config.json, history.jsonl, projects/d-rn-d-claudecodeui-contrib/4d4efd32-*.jsonl/.meta.json/.checkpoints.jsonl), and (d) the brownfield repo surfaces the spine claims to bind (`server/shared/types.ts`, `provider.registry.ts`, `provider.routes.ts`, `provider-capabilities.service.ts`, `session-synchronizer.service.ts`, `sessions-watcher.service.ts`, `session-conversations-search.service.ts`, `provider-token-usage.service.ts`, `sessions.service.ts`, `database/schema.ts`, `database/migrations.ts`, `notification-orchestrator.service.js`, `commands.routes.ts`, claude/codex/opencode provider facets, frontend `src/shared/*`, `useProviderAuthStatus.ts`, etc.).

## Gate verdict

**CONCERNS.** This is not an assertion-from-training-data spine: nearly every named CLI fact (flags, NDJSON grammar, exit-code table, session JSONL layout, `status --json` fields, human `--list-models` output, skills roots/precedence, `.mcp.json` scopes and top-level `mcpServers` shape) is verified **accurate against the live binary and current docs as of today**. What prevents a PASS is that AD-3/AD-8/AD-9/AD-11 leave four binding, two-builder divergence risks undecided (sidecar `.jsonl` ingestion, MCP per-server key divergence, token-usage service fall-through, tree-to-linear branch semantics), and the capability matrix — a whole structural dimension this feature owns — is left to the implementer except for `permissionModes`.

---

## 1. Verdict per AD

### AD-1 — Provider id `command-code` — ✅ CORRECT, consistent with the codebase

- Repo convention verified: providers live at `server/modules/providers/list/<id>/` (`claude`, `codex`, `cursor`, `opencode` — `read_directory`), registered by literal key in `provider.registry.ts` (`Record<LLMProvider, IProvider>`), parsed by allow-list in `provider.routes.ts` `parseProvider`, union-typed in `server/shared/types.ts:69` and `src/shared/types.ts:8`.
- A kebab-case id is conventional (`command-code` is a directory/binary-name that appears verbatim at 4 registration sites per provider today). Folder `command-code/` and literal `'command-code'` match npm package name and binary. `cmdc` as spawn alias only (AD-2) matches docs ("On Windows the alias is cmdc"; full `command-code` works everywhere). No `cmd`/`commandcode` alias anywhere in repo today — nothing contradicts.
- Rule is enforceable: unions are compile-checked; registry is `Record<LLMProvider,…>`; `parseProvider` is a runtime allow-list. No change.

### AD-2 — Spawn `command-code`, not `cmdc` — ✅ CORRECT and enforceable

- Live: both `command-code` and `cmdc` resolve on PATH via npm shims (`command-code`, `command-code.cmd`, `cmdc`, `cmdc.cmd`). Docs confirm `command-code` works everywhere; `cmdc` is Windows-only.
- cross-spawn is the repo convention (used by `opencode-runtime.provider.js`, `claude-auth.provider.ts`, `opencode-auth.provider.ts`), and its whole purpose is `.cmd`/PATHEXT resolution. The rule "never special-case `cmdc`" is testable on both OSes and prevents exactly the stated platform fork. No change.

### AD-3 — JSONL-per-session (claude/codex family) — ✅ DIRECTION CORRECT; ⚠️ one binding gap (HIGH)

Verified true:
- Live `C:\Users\asiqu\.commandcode\projects\d-rn-d-claudecodeui-contrib\4d4efd32-….jsonl` exists; docs: `~/.commandcode/projects/<project-slug>/<session-id>.jsonl` + sidecars `<id>.meta.json`, `<id>.share.json`, `<id>.checkpoints.jsonl`, `<id>.prompts.jsonl`. Per-session files ⇒ JSONL-per-session family, NOT opencode shared SQLite; `jsonl_path` must be real and per-session delete valid. Correct family call.
- File grammar is genuinely its own: line 1 header `{"type":"session","version":3,"id":…,"cwd":…}`, then `{"type":"message","id":…,"parentId":…,"timestamp":…,"message":{role,content,…},"messageId":…}` entries forming a **tree** (live lines confirm `parentId` chains and branching). Claude's grammar is `{"type":"user"|"assistant",…}` linear; Codex differs again. So "model on claude" is right only at the *file-layout* level; the parser must be dedicated (the spine says this in Deferred for search but not for the sessions/synchronizer facets themselves).

**GAP (HIGH) — sidecar `.jsonl` ingestion collision.** The Rule says verbatim: *"`sessionSynchronizer` scans `~/.commandcode/projects/**/*.jsonl`."* Command Code's **`.checkpoints.jsonl` and `.prompts.jsonl` sidecars end in `.jsonl`** (a real `.checkpoints.jsonl` exists live next to the transcript) and share the session id. A scan/`synchronizeFile` without an exclusion will index those sidecars as standalone sessions and overwrite the parent row's `jsonl_path` — the exact corruption mode claude's synchronizer defends against with `isSubagentTranscript` (`claude-session-synchronizer.provider.ts:40-43`). Two builders (sessions vs synchronizer) will diverge unless the spine pins an exclusion rule equivalent to claude's. The repo's `sessions-watcher.service.ts` `isWatcherTargetFile` returns true for any `*.jsonl` (non-opencode), so the watcher path has the same hole. **Fix: add an AD-3 sentence — "ignore `*.checkpoints.jsonl`, `*.prompts.jsonl`, `*.share.json`, `*.meta.json` and anything under a sidecar name pattern; only `<session-id>.jsonl` whose header `type==='session'` is a session."**

Also note `~/.commandcode/projects/<slug>/mcp.json` (local MCP scope, AD-8) lives under the same tree — `.json`, harmless to a `.jsonl` scan, but the synchronizer's recursive directory walk should not assume every file under `projects/` is a transcript.

### AD-4 — Auth = `command-code status --json` — ✅ CORRECT, with two caveats (LOW)

Verified live: `command-code status --json` → exit 0 and single JSON line:
`{"authenticated":true,"version":"1.45.0","user":"asiqur-rahman","model":"deepseek/deepseek-v4-flash","context_window":1000000}`.
So the spine's claimed fields (`authenticated`, `version`, `user`, `model`) are present; the live payload additionally carries `context_window` (forward-compatible, harmless — worth a note since the spine quotes the shape as complete). Docs list `cmd status --json` as "Emit status as a single JSON line for automation."
- Hand-parsing `~/.commandcode/auth.json` would indeed be fragile — live auth.json is `{apiKey,userId,userName,keyName,authenticatedAt}` (private, key-name-bearing). The AD's premise holds.
- Caveat A: **exit code 3 for not-authenticated is asserted but not exercised here** (this host is authenticated, exit 0). Docs' exit-code table (0,1,3-10,130) is documented for `-p` runs; the `status` subcommand's unauthenticated exit is plausibly 3 but unverified without a logout. Require a test that stubs/logs-out to confirm the combined signal (exit code + `authenticated:false` in JSON), and specify which wins on conflict.
- Caveat B: ENOENT→`installed:false` matches repo `ProviderAuthStatus` semantics (claude/opencode both probe binary then credentials). Enforceable. Minor: the probe currently runs a *second* subprocess (`--version`) in every other provider before credential checks; AD-4's single-command approach is actually cleaner — keep it.

### AD-5 — Curated catalog; active model from disk — ✅ DIRECTION CORRECT; ⚠️ two caveats (MEDIUM)

Verified: `command-code --list-models` prints **human grouped text** — live first lines: `Available models · 67 models` then provider groups ("Open Source", …) and space-aligned rows like `deepseek/deepseek-v4-flash  fast hybrid-attention reasoning (default)`. Not machine-parseable → curated `ProviderModelsDefinition` is the right call and consistent with repo (claude/codex both ship `*_PREDEFINED_MODELS`; claude's catalog is explicitly source-controlled, `claude-models.provider.ts:280-293`).
- Example id `deepseek/deepseek-v4-flash` verified present live.
- Caveat A (MEDIUM): **the live `<id>.meta.json` contains only `{"traceIds":[…],"title":"Product Manager Setup"}` — no `model` key.** The model lives on assistant transcript entries (`"model":"deepseek/deepseek-v4-flash"` on each assistant line) and in `status --json`. Docs claim the model "is stored in its meta," but the observed meta does not carry it. The AD's Rule ("from `<id>.meta.json` / transcript like claude") is therefore ambiguous about precedence — pin it: read the newest assistant message's `model` from the transcript tail, with meta as fallback (mirror `readClaudeSessionModelFromJsonl` which scans the last model-bearing line). Otherwise the sessions and models builders will diverge on what "active model" means for a resumed session.
- Caveat B (LOW): docs state unknown `-m` ids are rejected at launch. Curated-catalog drift is therefore not cosmetic — a stale id fails the run. The Deferred "live refresh" is acceptable for cold start, but the spine should note the failure mode is user-visible, not silent.

### AD-6 — Headless runtime `-p` + NDJSON, claude-style lifecycle — ✅ ACCURATE; ⚠️ permission-mode vocabulary + one unbound case (MEDIUM)

All flags verified against live `command-code --help` and docs: `-p/--print`, `--output-format json`, `--resume <id>` (no bare picker in print mode), `--continue/-c`, `-m/--model`, `--effort`, `--permission-mode`, `--max-turns` (default 100), `--no-auto-update`, plus `--session <path|id>`, `--fork-session`, `--yolo`, `--auto-accept`, `--plan`, `--trust`, `--skip-onboarding`, `--tools-all/--tools-enable`, `--verbose` (session id to stderr).
NDJSON grammar verified: event frames `{"type":"event","event":{…AgentEvent…}}` + one final `{"type":"result","subtype":"success|error|max_turns","sessionId":?,"stopReason":?,"usage":{…},"durationMs":N,"finalText":…,"error":?}`; `sessionId`/`stopReason` optional and omitted on early errors. Exit-code table 0,1,3-10,130 matches docs exactly, including 8 = max-turns and 130 = SIGINT/SIGTERM.
- The codex/opencode guarded-lifecycle skeleton (single `complete`, abort idempotence via `aborted` flag, session-id capture from the stream/result) is the right template — confirmed in `opencode-runtime.provider.js` and `codex-runtime.provider.js`.
- Caveat (MEDIUM): **`--permission-mode` accepted vocabulary is not one stable set in the docs/help**: live top-level help says `(standard, plan, auto-accept)`; the CLI Reference page says `default, plan, auto-accept, dont-ask` (legacy `standard` accepted); Headless page says `standard, plan, auto-accept`. The spine defers the mode mapping to "the real `--permission-mode` set" (AD-9), but the repo capability matrix needs a single ordered UI cycle (`provider-capabilities.service.ts` `permissionModes`), and the runtime must translate it. Decide the exact vocabulary + `default`↔`standard` mapping in the spine, or the runtime and capabilities builders will ship two different sets.
- Caveat (LOW): headless sessions are hidden from the interactive picker and carry no title until named — sidebar/synchronizer will show untitled entries for every automated run unless the UI suppresses them; not a contradiction, but a UX consequence worth one line.

### AD-7 — Skills = Agent Skills, `/` prefix, `.commandcode` + `.agents` roots — ✅ ACCURATE; ⚠️ one evidence mislabel (LOW/MEDIUM) + omissions

Verified against docs: user roots `~/.commandcode/skills/` **and** `~/.agents/skills/`; project roots `.commandcode/skills/` **and** `.agents/skills/` walked up to 10 levels (stopping at home); `.commandcode/skills/` wins name conflicts over `.agents/`; recursive discovery with `name`-must-match-directory; `SKILL.md` frontmatter; prefix `/` plus `/skill:<name>`; `--skill` and `settings.json` `skills` array as extra sources. All as claimed.
- **Evidence mislabel (LOW):** AD-7 says "(Verified: this environment already uses `.commandcode/skills`)." It does not — this repo's `.commandcode/` contains only `settings.json` and `taste/taste.md`, and the 80 project skills live under **`.agents/skills/`** (verified: glob found 80 `SKILL.md`s; the live CC transcript shows `.agents/skills/bmad-agent-pm` being loaded through `.agents`). The *correct* live proof is `.agents/skills` compatibility (which memlog item 11 wrongly calls "not yet exercised in-repo" — it is, every session). Both AD-7's parenthetical and memlog 11 should be corrected; the mislabel is exactly the kind of training-data-ish gloss this review exists to catch, though the underlying rule is right.
- Omissions (LOW): `disabledSkills` filter in `settings.json`, extra `skills` array locations, and the `/skill:` namespace are part of the CLI's discovery contract and absent from the facet's bindings. For a UI that lists skills, a disabled skill shadowing the list is a divergence two implementers could handle differently.

### AD-8 — MCP = Claude-shape `.mcp.json`, scopes user/project/local — ✅ TOP-LEVEL CORRECT; ⚠️ PER-SERVER SCHEMA DIVERGENCE (HIGH)

Verified against docs: scopes local (`~/.commandcode/projects/<slug>/mcp.json`), project (`.mcp.json` at project root), user (`~/.commandcode/mcp.json`); precedence local > project > user; `.mcp.json` top-level is `{"mcpServers":{…}}`; the repo `McpScope = 'user'|'local'|'project'` union matches Command Code exactly. Transport reality: `cmd mcp add --transport stdio|http`; SSE appears only as a legacy/OAuth-capable transport in passing — official transports are **stdio and http**.

**GAP (HIGH) — per-server key names diverge from the claude template.** The repo's claude facet writes per-server entries with a **`type`** discriminator (`claude-mcp.provider.ts:77-96`: `{type:'stdio',command,args,env}` / `{type:'http',url,headers}`). Command Code's canonical per-server entry uses **`transport`**, not `type` — docs' project-scope example is `{"mcpServers":{"stripe":{"transport":"http","url":…}}}` and its config schema shows `{"transport":"http","enabled":true,"url":…,"headers":…,"env":…}`; `cmd mcp add-json` accepts `type` *only as an alias*. The spine says "Command Code consumes the same `{"mcpServers":{…}}` shape as claude" and "Reuse the claude-mcp provider as the closest template" — the top level is shared, but a literal template copy writes `type` keys Command Code will not read, and the stdio entry shape (transport + enabled, `--` separated command) differs. **Fix: AD-8 must state the per-server discriminator is `transport` (write-compatible with Command Code) and that `type` is read-accepted only as an alias; also that official transports are stdio/http with SSE legacy.** Two builders cloning claude-mcp with different degrees of field remapping is a guaranteed divergence otherwise.

### AD-9 — Registration is id-driven and additive — ✅ SOUND; ⚠️ one enumerated site missing (HIGH)

The spine's blast-radius checklist was spot-checked against the repo and is real: `LLMProvider` unions (both sides), `provider.registry.ts`, `provider.routes.ts` `parseProvider`, `provider-capabilities.service.ts`, `session-synchronizer.service.ts` `processedByProvider` (line 82), `sessions-watcher.service.ts` `PROVIDER_WATCH_PATHS`, `agent.routes.ts`, `commands.routes.ts` `MODEL_PROVIDERS`, `shell-websocket.service.ts`, `schema.ts` CHECK, frontend `PROVIDERS` lists / logos / labels / constants. Verified enumerations exist at all of these. The "capability matrix drives UI" principle is real (`provider-capabilities.service.ts:1-37`).

**GAP (HIGH) — `provider-token-usage.service.ts` is an unbound per-provider-branch site.** This service dispatches on provider: cursor → zero (`unsupported`), opencode → its SQLite, codex → codex session file, then **falls through to a Claude parser and a `~/.claude/projects/<slug>/…jsonl` path derivation for everything else** (lines 384-475). The requirements doc's §5 "Per-provider conditional branches" list *does* flag `provider-token-usage.service.ts`, but the spine's AD-9 checklist and AD-11 subset list do not bind it, and no AD decides `supportsTokenUsage` for Command Code. Without a branch, a Command Code session's token-usage endpoint will compute a bogus `~/.claude` path and 404 — and Command Code's own JSONL stores per-assistant-line `usage` (verified live), so the data is available and worth surfacing. **Fix: bind the file in AD-9 and record the decision (implement usage from transcript tail, mirroring the codex/claude pattern).**

### AD-10 — Schema CHECK via migration only — ✅ CORRECT and enforceable

Verified: `provider_models.provider` has `CHECK (provider IN ('claude','cursor','codex','opencode'))` (`schema.ts:181`); the `sessions.provider` column has no CHECK. SQLite cannot ALTER a CHECK — the repo already rebuilds tables for schema changes (`migrations.ts` `rebuildSessionsTableWithProjectSchema`, `rebuildProjectsTableWithPrimaryKeySchema`), so the "table-rebuild migration, never raw schema edit for live DBs" rule matches an existing, working mechanism (`runMigrations`). Enforceable by code review + a migration test. No change.

### AD-11 — Narrow subsets deliberate and documented — ✅ SOUND; one map claim verified

Verified: search is genuinely claude+codex-only (`session-conversations-search.service.ts:11`, `SUPPORTED_PROVIDERS` line 95); notification `PROVIDER_LABELS` is genuinely missing opencode (`notification-orchestrator.service.js:12-16` has claude/cursor/codex/system) — so "add `command-code` and fix the omission" is an accurate, concrete instruction. The explicit "leave out unless a story widens it" rule is the right guard for the search deferral.

---

## 2. Deferred items — divergence risk re-check (Q4)

| Deferred item | Risk that two builders one level down diverge |
| --- | --- |
| Fork/editing hooks | **Low.** Repo precedent exists for providers without a fork facet (cursor/opencode advertise `supportsSessionForking:false` and the service already special-cases "no transcript yet"). `sessions.service.ts` fork path requires `provider_session_id`+`jsonl_path` and calls `fork.forkSession` — a provider with no fork facet must be capability-gated; add a one-line note that the fork route returns an explicit "not supported for command-code" rather than a generic 500. Command Code *does* support `/fork`/`--fork-session` headlessly; only editing-anchor parity is unproven, so the deferral itself is right. |
| Conversation search | **Low/Medium.** AD-11 explicitly says leave it out unless a story widens it — the guard exists. The only residual risk is that "Command Code's tree-shaped JSONL" is claimed to need a new parser *later* while the tree-vs-linear question is already undecided for the non-search facets (see Silent dimensions, item 2) — the deferred parser inherits that ambiguity. |
| Git commit-message generator / cli sandbox | **Low.** Explicitly ruled by AD-11. |
| Curated model list maintenance | **Low divergence between builders** (single catalog file), but note the drift failure is user-visible (`-m` rejects unknown ids) — worth surfacing in the story, not silently deferred. |
| Operational envelope | **Low.** Matches "self-hosted app, no new deploy dimension." Correct to defer. |

None of the Deferred items is a *two-builder* trap on its own, but item 1 needs the capability-gate note and item 4's failure mode should be documented.

---

## 3. Structural dimensions left silent (Q5)

1. **Capability matrix for `command-code` (HIGH).** AD-9 says only "set `permissionModes` etc. to Command Code's real `--permission-mode` set." The matrix (`supportsImages`, `supportsFiles`, `supportsAbort`, `supportsPermissionRequests`, `supportsTokenUsage`, `supportsEffort`, `supportsMessageEditing`, `supportsSessionForking`) drives the whole UI with zero per-provider branches — every one of those flags is an AD-level decision for this provider and none is made. Concrete hazards: (a) image/file attachments — the CLI has **no image or file attachment flag** in `-p` mode; `supportsImages:true` (claude/codex/opencode all true) would offer an upload UI whose payload has no CLI vehicle; (b) interactive permission requests — headless mode has no interactive prompt channel (default denies writes), so `supportsPermissionRequests` must be false and the permission decision happens via `--permission-mode`/`--yolo` pre-launch; (c) `supportsTokenUsage`/`supportsMessageEditing`/`supportsSessionForking` feed the token-usage service and fork route above. **Fix: add an AD (or extend AD-9) that fixes each capability flag and the mode→flag mapping.** This is the single largest undecided surface the feature owns.
2. **Tree-shaped JSONL → linear history semantics (HIGH).** Command Code transcripts are append-only trees (`parentId`); `/rewind` "persists" (docs) without rewriting the file, and later entries append after the rewind point. The UI/session history is a single linear conversation, so the sessions facet, the synchronizer (title/model/row), and the watcher must agree on *which* path through the tree is "the session" and what happens to messages past a rewind/fork point. The live `.meta.json` (traceIds + title only) does not obviously persist a "current pointer," so this needs an empirical check and a decision — neither the spine nor any AD binds it. Two builders flattening the tree differently (all branches chronologically vs. active branch only) is a guaranteed divergence; it also cascades into the deferred search parser.
3. **Electron surfaces (LOW/MEDIUM).** `electron/main.js`, `electron/desktopWindow.js`, `electron/serverInstaller.js`, `electron/launcher/launcher.css` all match provider names (`grep`), and the spine's blast radius lists neither electron nor the desktop-launcher provider set. If the desktop shell enumerates provider logos/commands, `command-code` will be missing there even after AD-9 is fully executed. Verify and either add to AD-9 or explicitly defer.
4. **Session-sidecar deletion (LOW).** Repo delete paths remove `jsonl_path` + superseded transcripts; Command Code sessions have four sidecars (`.meta.json`, `.checkpoints.jsonl`, `.share.json`, `.prompts.jsonl`). "Per-session deletable" (AD-3) without a sidecar-cleanup rule leaves orphaned state that the synchronizer then re-imports. Small, but decide it.

---

## 4. Consolidated findings (tiered)

**Critical:** none (no fabricated technology, no wholesale contradiction of the brownfield codebase, no load-bearing CLI fact that is wrong).

**High**
1. AD-3/AD-9 gap: `*.checkpoints.jsonl` / `*.prompts.jsonl` sidecars will be ingested by the verbatim `~/.commandcode/projects/**/*.jsonl` scan and by the watcher's `*.jsonl` predicate, overwriting parent `jsonl_path` rows — the exact corruption claude's synchronizer filters against. Pin an exclusion rule (and file-scope it to `<session-id>.jsonl` with a `type:"session"` header). *Live sidecar file present on this host.*
2. AD-8 gap: per-server `.mcp.json` entries use **`transport`** (Command Code) vs **`type`** (claude template the AD names); official transports are stdio/http, SSE legacy. "Same shape as claude" is true only at the `mcpServers` top level. Reuse-without-field-remap silently writes config Command Code won't load.
3. AD-9 omission: `provider-token-usage.service.ts` is a per-provider dispatch that falls through to Claude parsing/path logic; unbound by AD-9/AD-11. Command Code sessions would 404 the token-usage endpoint despite per-message `usage` existing in its JSONL. `supportsTokenUsage` undecided.
4. Silent dimension: the entire capability matrix for `command-code` (images, files, permission requests, token usage, effort, editing, forking, abort) is undecided except `permissionModes`, and the `--permission-mode` vocabulary itself is inconsistent across live help (`standard|plan|auto-accept`) and docs pages (`default|plan|auto-accept|dont-ask`). With zero per-provider frontend branches, an undecided matrix is a divergence machine.
5. Silent dimension: tree→linear branch semantics for history/sidebar (rewind/fork tails) are undecided and empirically unverified; sessions, synchronizer, and the deferred search parser must agree.

**Medium**
6. AD-5: live `.meta.json` has no `model` key (only `traceIds`+`title`); model lives on assistant transcript lines. Pin precedence (transcript-tail model, meta fallback) or the models/sessions builders diverge.
7. AD-7 evidence mislabel: repo uses `.agents/skills` (80 skills live), *not* `.commandcode/skills`; memlog item 11's "not yet exercised in-repo" is also wrong (it is exercised every session). Rules themselves are accurate. Also: `disabledSkills`, settings `skills` extra roots, and `/skill:` namespace omitted from bindings.
8. AD-4: exit-3-not-authed is asserted, not exercised (host is authenticated, exit 0); docs' exit table is specified for `-p`. Require an unauthenticated-path test and state conflict precedence between exit code and `authenticated:false` in the JSON body. Live payload also carries `context_window` beyond the quoted shape.

**Low**
9. Electron/desktop surfaces enumerate providers but are absent from the blast-radius checklist.
10. Fork deferral needs an explicit "return unsupported, don't 500" capability-gate note (precedent: cursor/opencode).
11. Curated-catalog drift fails loudly (`-m` rejects unknown ids) — document the failure mode in the story.
12. Session-delete sidecar cleanup undecided; headless sessions surface as untitled in the sidebar unless the UI filters them.

---

## 5. What was verified live / from current docs (evidence)

- `command-code --version` → 1.45.0; `command-code` and `cmdc` both on PATH (npm shims). Stack table "1.45.0 (verified live)" correct.
- `command-code status --json` → exit 0, `{authenticated,version,user,model,context_window}` — AD-4 shape confirmed (plus one extra field).
- `command-code --list-models` → human "Available models · 67 models" grouped text; AD-5 rationale confirmed.
- `--help`/docs cross-check: all AD-6 flags exist; NDJSON two-shape grammar and exit-code table 0,1,3–10,130 match docs exactly.
- `~/.commandcode/projects/d-rn-d-claudecodeui-contrib/4d4efd32-…`: `.jsonl` (header `type:"session"` + `parentId`-linked `type:"message"` entries with per-assistant `model`/`usage`), `.meta.json` (`traceIds`, `title` only), `.checkpoints.jsonl` present → AD-3 layout confirmed and finding 1 demonstrated.
- Skills docs: roots, `.commandcode`-wins precedence, recursion, `/` + `/skill:` prefix confirmed; repo genuinely runs on `.agents/skills`.
- MCP docs: scopes local/project/user + file locations and precedence confirmed; per-server `transport` discriminator and stdio/http transport set confirmed (finding 2).
- Repo: every AD-9 registration site listed exists and enumerates today's four providers; search = claude+codex; notification labels lack opencode; CHECK constraint and table-rebuild migration mechanism exist; cross-spawn convention and `ProviderModelsDefinition`/predefined-model pattern confirmed.

## 6. Recommended spine edits (small, high-leverage)

1. AD-3: add sidecar-exclusion rule for the synchronizer and watcher (`*.checkpoints.jsonl`, `*.prompts.jsonl`, `*.share.json`, `*.meta.json`; require header `type:"session"`).
2. AD-8: state per-server discriminator = `transport` (write-compatible; `type` read as alias only), transports stdio/http (+SSE legacy), and that the claude-mcp template needs a field-map layer, not a copy.
3. AD-9: bind `provider-token-usage.service.ts`; decide `supportsTokenUsage` (read per-message `usage` from transcript tail).
4. New/extended AD (or Capability block): fix every capability flag for `command-code` and the exact `--permission-mode` vocabulary + `default`↔`standard` mapping; explicitly set `supportsImages/supportsFiles` semantics given no `-p` attachment flag, and `supportsPermissionRequests:false` (headless has no interactive prompt channel).
5. New decision under an AD or Deferred: tree→linear active-branch semantics for history/sidebar (empirically confirm where the rewind pointer persists — docs say rewinds persist but the live `.meta.json` shows no pointer).
6. Fix AD-7's evidence note and memlog 11 (`.agents/skills`, exercised live); note `status --json` also returns `context_window`.
