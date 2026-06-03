# Changelog

## [Unreleased] — review & hardening pass

### Security
- **web_fetch DNS-rebinding 防护**:对域名做解析后 IP 校验(`assertHostPublic`),拦截解析到内网/环回地址的域名;重定向每一跳同样校验
- **web_fetch 响应体大小上限**:流式读取并按 `MAX_BYTES` 截断,缺失 `content-length` 的超大响应不再耗尽内存(`readCapped`)
- **路径限界识破软链逃逸**:`confineToRoot` 用 realpath 解析最近已存在祖先,拦截项目内软链/Windows junction 指向项目外的情形

### Bug Fixes
- **High**:工作流全缓存恢复路径用量恒为 0 —— `closeRun` 不回写 `runs.total_*`,改为从 `agent_calls` 逐调用记录求和
- 流式请求超时改为**空闲超时**(每 chunk 重置),稳定的长输出不再被「总时长」上限误杀

### CLI/UX & Docs
- system prompt 补全工具清单:加入 `web_search` 并提示存在 git/task/remember/cron 工具家族(此前模型对它们「隐身」)
- 修正 README Phase 11 虚标(此前声称的 Markdown 渲染 / 语法高亮尚未实现)
- 新增中文文档 `README.zh-CN.md`,与英文 README 互链

### Refactor / Tests
- 抽出 `src/cli/wiring.ts`(`registerGitTools` / `registerTaskTools` / `registerCronTools`),为 1100+ 行的 `cli.ts` 入口瘦身
- task 单测改用 `os.tmpdir()` + `mkdtemp` + 清理,不再在仓库工作树留 `.floom-test-*` 产物;`.gitignore` 加防御行
- 测试数 506 → 511(新增软链逃逸、DNS 重绑定、响应体上限等用例)

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
