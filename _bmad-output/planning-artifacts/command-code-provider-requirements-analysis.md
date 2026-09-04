# Requirements Analysis — Add "Command Code" as a coding-agent provider

**Date:** 2026-09-03
**Status:** Analysis complete — ready for architecture / engineering handoff
**Analyst:** Mary (Business Analyst)
**Target repo:** `claudecodeui-contrib` (fork of claudecodeui / CloudCLI)

## 1. What the user wants

CloudCLI is a web + desktop UI that drives terminal coding agents (Claude Code, Codex,
Cursor, OpenCode). Add **Command Code CLI** as a supported coding agent alongside them, so
sessions, skills, MCP, models, and auth for `command-code` surface in the same UI the way the
other four do.

## 2. What Command Code is (verified)

- Command Code (`command-code`, npm) is a coding-agent CLI with interactive and
  **headless (`-p` / `--print`)** modes. On Windows the binary is `cmdc` (because `cmd` is the
  shell); `command-code` works on every OS. Installed via `npm i -g command-code`.
- It implements the **Agent Skills open standard** and reuses `.agents/skills/` and
  `~/.agents/skills/` as compatibility locations.
- It persists sessions as **per-project JSONL transcripts**, plus sidecar meta/checkpoint
  files — the same storage family as Claude Code / Codex, *not* OpenCode's shared SQLite.
- Auth is Command-Code-account based (`cmd login`); config lives under
  `~/.commandcode/` (user) and `.commandcode/` (project).
- The core repo (CommandCodeAI/command-code) is effectively closed-source (a public readme
  repo), so there is **no open-source SDK/source to mirror**; integration must target its
  documented CLI contract.
- Third-party integrations (e.g. commandcode-mcp) already drive it headlessly via
  `commandcode -p "…"` and `--resume`/`--continue` — proof the headless contract is usable.

## 3. Command Code CLI contract (authoritative, from docs)

### Invocation / flags
| Concern | Flag / value |
| --- | --- |
| Non-interactive run | `-p, --print [query]` (or `--output-format json` for NDJSON) |
| Resume a specific session | `-r, --resume <id>` / `--session <id\|path>` |
| Continue most recent in cwd | `-c, --continue` |
| Fork / branch | `--fork-session` (with resume/continue) |
| Don't persist | `--no-session` |
| Cap turns | `--max-turns <n>` (default 100; **exit code 8** when hit) |
| Model / effort | `-m, --model <id>` ; `--effort <low\|medium\|high\|…>` |
| Permissions | `--yolo` (alias `--dangerously-skip-permissions`); `--auto-accept`; `--permission-mode <default\|plan\|auto-accept\|dont-ask>`; `--plan` (read-only); `-t, --trust` |
| Skills / discovery control | `--skill <path>` (repeatable); `--no-skills` |
| Config | `--config <key=value>` (repeatable; the headless form of `/config`) |
| Automation hygiene | `--skip-onboarding`, `--no-auto-update` |
| List models | `cmd --list-models` |
| Auth/status subcommands | `cmd login`, `cmd logout`, `cmd status --json`, `cmd whoami`, `cmd info` |

> **Windows note:** binary is `cmdc`, so all spawn args must target `cmdc` (or `command-code`)
> — and the existing runtime adapters already handle `.cmd` shims via cross-spawn.

### Headless output (`--output-format json`)
Newline-delimited JSON (NDJSON), two shapes, **one object per line**:
1. **Event frames** — `{"type":"event","event":{...AgentEvent...}}` e.g. a `tool_running`
   event with `toolName`. `event.type` vocabulary is forward-compatible; unknown types must be
   ignored.
2. **One final result line, always last** —
   `{"type":"result","subtype":"success|error|max_turns","sessionId":?,"stopReason":?,"usage":{...},"durationMs":N,"finalText":"…","error":?}`.
   `sessionId` and `stopReason` are **optional** and omitted on early errors; `usage` is the
   run's token totals.

### Exit codes (important for the runtime lifecycle)
| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | General error |
| 3 | Not authenticated |
| 4 | Permission denied |
| 5 | Rate limited |
| 6 | Network failure |
| 7 | API server error |
| 8 | **Max turns reached** (cap hit) |
| 9 | No response |
| 10 | Insufficient credits |
| 130 | Interrupted (SIGINT/SIGTERM) |

### Session storage on disk
```
~/.commandcode/projects/<project-slug>/<session-id>.jsonl        # transcript (header + tree entries)
~/.commandcode/projects/<project-slug>/<session-id>.meta.json    # title, model, lineage, compaction stats
~/.commandcode/projects/<project-slug>/<session-id>.checkpoints.jsonl
~/.commandcode/projects/<project-slug>/<session-id>.share.json
~/.commandcode/projects/<project-slug>/<session-id>.prompts.jsonl
```
- One append-only **JSONL** file per session, keyed by a slug of the working directory.
- Entries form a **tree** (each points at a parent) — `/fork`, `/rewind`, `/tree`.
- Session resume by **exact session id** is supported headlessly; **no bare picker** in print mode.
- Headless (`-p`) sessions persist but are hidden from the interactive picker — automation
  doesn't pollute history; a session-id can still resume them.

### Skills discovery (Agent Skills standard + compatibility)
| Scope | Location(s) | Prefix |
| --- | --- | --- |
| User | `~/.commandcode/skills/` ; also `~/.agents/skills/` | `/` |
| Project | `.commandcode/skills/` (project root) ; also `.agents/skills/` walked up to 10 dir levels | `/` |
| Extra | `--skill <path>` flags; `settings.json` `skills` array | `/` |

`SKILL.md` files, standard frontmatter (`name`, `description`), recursive discovery under a
grouping folder, `name`-must-match-directory validation, `/skill-name` invocation (plus
`/skill:<name>`). `.commandcode/skills/` wins name conflicts over `.agents/skills/`.

### MCP / config layout (for the MCP facet)
- CLI to manage: `cmd mcp add <name> --transport <stdio|http> [--scope ...] -- <cmd> [args]`.
- Hand-written file: `.mcp.json` in the project root (same Claude-style shape —
  `{"mcpServers":{...}}`), plus user scope `~/.commandcode/mcp.json` and a "local" private scope
  under `~/.commandcode/projects/<slug>/mcp.json`.
- Settings/config files: `~/.commandcode/settings.json` (user), `.commandcode/settings.json`
  (project), `.commandcode/settings.local.json`.

## 4. How the target repo integrates providers (the seam)

Every provider lives in its own folder under `server/modules/providers/list/<id>/` and
exposes **seven facets** (plus optional `fork`). The repo README explicitly documents
"Adding a provider." Facets:

| Facet | Interface | Responsibility |
| --- | --- | --- |
| `runtime` | `IProviderRuntime` | Spawn/abort the live CLI process (a `.js` plain object) |
| `models` | `IProviderModels` | Supported/active model resolution |
| `auth` | `IProviderAuth` | Install/auth state (`getStatus()`) |
| `mcp` | `IProviderMcp` / `McpProvider` | Read/write provider-native MCP config |
| `skills` | `IProviderSkills` / `SkillsProvider` | Discover provider-native skills |
| `sessions` | `IProviderSessions` | Normalize live events; fetch history |
| `sessionSynchronizer` | `IProviderSessionSynchronizer` | Scan on-disk transcripts → DB |

**Two storage families exist:**
- **Per-session artifact (JSONL file):** claude, codex, cursor → `jsonl_path` column set, watch
  a folder for `*.jsonl`, `createSession` carries a real `jsonlPath`, forks copy files.
- **Shared store:** opencode (single shared SQLite DB) → `jsonl_path` stays `null`.

**Command Code maps to the JSONL-per-session family** (`~/.commandcode/projects/<slug>/*.jsonl`),
so the **claude or codex provider is the modeling template**, NOT opencode.

## 5. Full blast radius — every place a provider id is hardcoded

Adding a provider touches every site that enumerates `claude | codex | cursor | opencode`.

### Backend (source of truth first)
| File | What to change |
| --- | --- |
| `server/shared/types.ts:69` | Extend the `LLMProvider` union |
| `server/modules/providers/list/command-code/` | **New folder** — facet files + wrapper |
| `server/modules/providers/provider.registry.ts:9-13` | Import + register the wrapper in the `Record` |
| `server/modules/providers/provider.routes.ts` `parseProvider` | Add id to the allow-list |
| `server/modules/providers/services/provider-capabilities.service.ts` | Add capability entry |
| `server/modules/providers/services/session-synchronizer.service.ts:82` | Add per-provider processed counter |
| `server/modules/providers/services/sessions-watcher.service.ts` | Add watch path + `*.jsonl` target predicate |
| `server/modules/agent/agent.routes.ts` | Guard list + dispatch chain (JSDoc, error string) |
| `server/modules/commands/commands.routes.ts` | `MODEL_PROVIDERS` allow-list + label map |
| `server/modules/websocket/services/shell-websocket.service.ts` | Spawn-command switch + label ternary (before the claude fallthrough) |
| `server/modules/database/schema.ts:181` | SQLite `CHECK (provider IN (...))` → **schema migration** |
| `server/modules/providers/services/session-conversations-search.service.ts` | Deliberate: `SearchableProvider` is only `claude|codex` — decide whether Command Code JSONL joins search |
| `server/modules/notifications/services/notification-orchestrator.service.js` | `PROVIDER_LABELS` map (currently missing even opencode) |
| `public/api-docs.html` | Regenerate / update provider list + order |
| `server/modules/providers/README.md` | Document the new provider |

### Frontend
| File | What to change |
| --- | --- |
| `src/shared/types.ts:8` | Extend the `LLMProvider` union (aliases `McpProvider`/`AgentProvider`/`SkillsProvider` propagate) |
| `src/shared/selectedProvider.ts` | Add to `PROVIDERS` list |
| `src/modules/chat/hooks/useChatProviderState.ts` | Add to `PROVIDERS` + fallback maps (efforts/models/permission modes) |
| `src/shared/constants.ts` | 5 MCP/provider maps (`MCP_PROVIDER_NAMES`, `MCP_SUPPORTED_SCOPES`, `MCP_SUPPORTED_TRANSPORTS`, `MCP_SUPPORTS_WORKING_DIRECTORY`, `PROVIDER_PERMISSION_PREFERENCE_KEYS`) |
| `src/shared/ui/LLMProviderLogo.tsx` | New `CommandCodeLogo.tsx` + branch (export via `src/shared/ui/index.ts`) |
| Agent/settings UIs | `AgentsSettingsTab.tsx`, `AccountContent.tsx`, `AgentSelectorSection.tsx`, `AgentCategory*Section.tsx` (visual configs, names) |
| Provider auth | `useProviderAuthStatus.ts`, `ProviderLoginModal.tsx` (login command/title per provider) |
| Provider selection surfaces | `AgentConnectionsStep.tsx`, `ModelLibraryPanel.tsx`, `ProviderSelectionEmptyState.tsx` (+ i18n), `SidebarSessionItem.tsx`, `ChatInterface.tsx` label ternaries |
| Label maps | `buildTranscriptMarkdown.ts`, `buildTranscriptHtml.tsx`, `CommandResultModal.tsx`, `MessageComponent.tsx` ternaries |
| Skills | `ProviderSkills.tsx` provider-name/path maps |

### Per-provider conditional branches (audit before implementing)
`sessions.service.ts` (`jsonl_path` decision), `provider-token-usage.service.ts`, claude-vs-codex
search branches, codex-specific MCP/formatting fields, opencode special-casing in agent settings.

## 6. Facet-by-facet integration mapping (Command Code)

| Facet | What Command Code needs | Template |
| --- | --- | --- |
| **auth** | Probe binary (`command-code` / `cmdc --version`); auth = `cmd status --json` (exit 3 = not authed); config under `~/.commandcode/` | opencode-auth (spawn-sync probe) + claude-auth (account login) |
| **models** | `cmd --list-models` live; or curated catalog from docs (`claude-*`, `gpt-*`, `gemini-*`, Kimi/GLM/Qwen/DeepSeek ids). `-m <id>`, `--effort` | codex/opencode-models |
| **runtime** | Spawn `command-code`/`cmdc` `-p <prompt> --output-format json` (+ `--resume <id>`/`--continue`, `-m`, `--effort`, permission flags). Parse NDJSON: event frames → normalized messages; final `result` line → token usage + stop reason. Map exit codes (8=max_turns, 130=interrupted, 3=auth, 10=credits). Session id handshake: capture `sessionId` from the result line | codex/opencode runtime `.js` (spawn/lifecycle skeleton) |
| **sessions** | `normalizeMessage` per NDJSON frame (tool_running etc.); `fetchHistory` from `~/.commandcode/projects/<slug>/<id>.jsonl` (JSONL tree — read the active branch; sidecar `.meta.json` has title/model) | claude/codex sessions |
| **sessionSynchronizer** | Scan `~/.commandcode/projects/**/*.jsonl`; parse header + tree entries; title from `.meta.json` (or first prompt); upsert with real `jsonlPath`; bind provider id ↔ app id like claude/codex | claude/codex synchronizer |
| **mcp** | Read/write `.mcp.json` (project) + `~/.commandcode/mcp.json` (user) — **same Claude shape**; scopes user/project/local; transports stdio/http/sse | claude-mcp (closest) |
| **skills** | Discovery roots `~/.commandcode/skills` + `.commandcode/skills` (project) + `.agents/skills` compat, recursive, prefix `/` | claude-skills (closest) |

**Modeling recommendation:** clone the **claude** provider folder as the closest structural
template (JSONL sessions + `.mcp.json` + `/` skills), but take the **codex/opencode runtime**
lifecycle skeleton for headless spawn/stream/abort, because Command Code's headless contract
(NDJSON + exit codes + `--resume`) is closest to those headless-first CLIs.

## 7. Open decisions to resolve with the user / architect

1. **Provider id / naming.** Suggest `'command-code'` (consistent with folder naming `command-code/`,
   npm package `command-code`) vs `'commandcode'`/`'cmd'`. **Recommend `'command-code'`.**
2. **Windows binary.** `cmdc` on Windows vs `command-code` everywhere. **Recommend** always spawning
   `command-code` and letting cross-spawn resolve (or resolving `cmdc` explicitly).
3. **Session-history search scope.** Currently claude+codex only. Include Command Code JSONL in
   `session-conversations-search`? (Requires parsing its JSONL tree format.)
4. **Skill write-back.** `SkillsProvider` managed global writes target `~/.commandcode/skills/`.
5. **MCP scope/transport matrix.** Confirm stdio/http (+ local scope) parity.
6. **Schema migration.** The SQLite CHECK constraint needs a migration path for the new provider
   id — coordinate with backend standards.

## 8. Verification commands (existing provider contract)

```bash
npx eslint server/modules/providers/**/*.ts server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
npm test
```

## 9. Suggested handoff

Research is complete. Next: an **architect** should ratify the integration seam against
`backend-module-standards` and the claude-provider internals, then an **engineer** scaffolds
`server/modules/providers/list/command-code/` + the registration points above, with focused
tests mirroring `opencode-sessions.test.ts` / `codex-sessions.test.ts`.

---

### Sources
- Command Code docs — Headless Mode / CLI Reference / Sessions / Skills (bundled authoritative
  reference at `node_modules/command-code/.../command-code-knowledge/reference/*.md`; public at
  https://commandcode.ai/docs)
- Target repo — `server/modules/providers/README.md`, explorer inventory of provider-id
  hardcodes, opencode provider blueprint
- Third-party example — IMRAN104/commandcode-mcp (drives Command Code headlessly via
  `commandcode -p` / `--resume` from other agents)
