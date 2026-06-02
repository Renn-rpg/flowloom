# Changelog

## [0.10.0] — Unreleased

### Architecture
- Extracted `src/cli/session-factory.ts` from cli.ts (159 lines)
- Added `src/model/factory.ts` — ModelClient factory pattern, eliminated direct DeepSeekClient imports from CLI layer
- Added `src/task/` module — lightweight task tracking (create/update/list)
- `src/agent/compaction.ts` — semantic context compaction (summarization-based trimming)

### Workflow Engine
- Structured output schema support (`agentStructured()` via `respond_json` tool)
- Nested workflow depth raised from 1 to 5 levels
- Fixed `inPrefix` resume dead code in workflow-runtime.ts
- Fixed `sealHostFn` Proxy blocking `.apply`/`.call`/`.bind` in sandbox

### Tools
- **Git tools**: expanded from 4 to 20 tools (diff, log, branch, commit, status, stash, worktree, fetch, push, pull, merge, rebase, reset, revert, blame, tag)
- **Task tools**: `task_create`, `task_update`, `task_list`
- **Skills**: filesystem-based skill auto-discovery (`~/.floom/skills/` + `.floom/skills/`)
- **Deep Review**: adversarial multi-agent code review skill (`/deep-review`)
- Skills tool allowlist enforcement (readOnly skills now actually filter tools)
- Independent shell policy for git commit (no longer shares bash "don't ask again" state)

### Security
- Fixed SSRF octal/hex/decimal IP bypass in `web_fetch`
- Atomic file writes via temp+rename pattern in `edit_file` and `multi_edit`
- MCP child process environment variable filtering (only allowlist, no credentials)
- `sealHostFn` Proxy blocks `constructor` access in VM sandbox

### CLI/UX
- `/compact` command for manual context compaction
- Skill parameterization (`/skill-name arg1 arg2` → `${1}`, `${2}`, `${args}`)
- Fallback model misconfiguration warning

### Tests
- Added 4 new test files: `router.test.ts` (13), `cron.test.ts` (21), `git.test.ts` (22), `compaction.test.ts` (19)
- Test count: 345 → 428 (+83)
- All critical modules now have test coverage

### Bug Fixes
- Critical: `inPrefix` resume totally non-functional (dead code)
- Critical: `sealHostFn` broke sandbox `run()` by blocking `.apply`
- High: `JSON.stringify(undefined)` in tool calls → API 400
- High: SSRF via octal IP notation
- High: TOCTOU race in edit_file/multi_edit (now atomic)
- Medium: Semaphore `release()` idempotency
- Medium: `estimateTokens()` missing `reasoningText`
- Medium: MCP missing `COMSPEC`/`PATHEXT` on Windows
- Medium: Context window truncation could produce orphan `tool_call_id`

## [0.9.0] — 2026-05-31
- Initial tracked version
- Core agent loop, REPL, 11 tools, workflow engine, MCP, hooks, plan mode, sub-agents
