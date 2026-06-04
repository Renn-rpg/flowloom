# Changelog

## [0.13.0] — review, hardening & UI/UX pass

### Features
- **流式 Markdown 渲染**(`src/cli/markdown.ts`):REPL + TTY 下把最终答案按 Markdown 渲染(标题/有序无序列表/引用/分隔线/粗体/斜体/行内 code/链接/删除线)。行缓冲流式;一次性/管道输出保持裸文本不污染
- **代码块语法高亮**(`src/cli/highlight.ts`):手写 mini-lexer(无第三方依赖),按围栏语言对注释/字符串/数字/关键字/字面量上色,支持 JS/TS/Python/Go/Rust/C 家族/JSON 等;跨行 `/* */` 块注释用小状态跟踪。`tokenizeLine` 与颜色解耦、保证拼回原行
- **流式中途 ESC 打断**:模型输出/思考期间按 `ESC` 立即中止本轮、退回提示符(`AbortSignal` 透传 `runTurn → generate`,内部联动空闲超时 controller);中断后弹出未应答的 user 消息保持历史一致,可用 `/retry` 重跑。raw 模式下 `Ctrl-C` 仍保留退出语义(先恢复终端再退出,不残留 raw 模式)
- **`@文件` 路径补全**:输入 `@` 弹出文件/目录下拉(目录在前、`node_modules`/`.git`/dist 等噪音与隐藏文件默认过滤),`Tab/Enter` 选中——目录补 `/` 可继续向下钻、文件补空格收尾。保留 `@` 作为文件引用标记;system prompt 已告知模型把 `@<path>` 当作「请读这个文件」。补全计算保持零 IO(目录列举依赖注入),邮箱式 `a@b` 不误触
- **`!` shell 透传 + `#` 快捷记忆**:REPL 行首 `!<command>` 直接跑 shell 并回显(用户显式输入,不进 agent、不经 shell 审批);`#<text>` 把一句话存成持久 memory(自动生成 slug 名,description 单行化,本会话即时生效)。两者均为纯解析(`parseReplDirective`)+ cli 侧副作用;`/help` 与欢迎屏已列出 `!`/`#`/`@` 前缀。`run_shell` 工具与 `!` 共用抽出的 `execShell`
- **终端标题 + 后台任务指示**:turn 进行中把任务摘要写进终端标题(`floom ⠿ …`,标签页可见在跑什么),空闲/退出复位;状态栏新增 `⏵N bg` 段——`run_shell background:true` 起的进程不再"隐形"(`BackgroundShells.runningCount()`)

### Security
- **web_fetch DNS-rebinding 防护**:对域名做解析后 IP 校验(`assertHostPublic`),拦截解析到内网/环回地址的域名;重定向每一跳同样校验
- **web_fetch 响应体大小上限**:流式读取并按 `MAX_BYTES` 截断,缺失 `content-length` 的超大响应不再耗尽内存(`readCapped`)
- **路径限界识破软链逃逸**:`confineToRoot` 用 realpath 解析最近已存在祖先,拦截项目内软链/Windows junction 指向项目外的情形

### Bug Fixes
- **Critical**:REPL **无限自动重试** —— `/retry` 用同一个 `retryLine` 变量既存「上一条 prompt」又当「待重试信号」,而 `runSlash('/retry')` 恒返回 `{retry:true}`,导致只要上一条非空就在循环顶部自激重试;每轮成功又重置它 → 对话一旦成功就停不下来。拆成 `lastLine`(每轮都记、不触发)+ `retryRequested`(仅 `/retry` 置位、消费一次),并抽纯函数 `takeReplInput` 加回归测试锁死「非空≠重试」语义
- **High**:工作流全缓存恢复路径用量恒为 0 —— `closeRun` 不回写 `runs.total_*`,改为从 `agent_calls` 逐调用记录求和
- 流式请求超时改为**空闲超时**(每 chunk 重置),稳定的长输出不再被「总时长」上限误杀
- **窄终端 / CJK 折行下工具行与 Ctrl+O 展开错位**:`onToolResult` 的「上移覆盖运行行」改为按真实物理行数上移(`physicalRows` = `visualWidth`(去 ANSI)/列宽),`blocks.ts` 的 `cursorDelta` 同样计入折行;`dispatch_agent`(执行期已打印进度树)不再上移覆盖

### CLI/UX & Docs
- system prompt 补全工具清单:加入 `web_search` 并提示存在 git/task/remember/cron 工具家族(此前模型对它们「隐身」)
- 修正 README Phase 11 虚标(Markdown 渲染 + 代码语法高亮本次均已补齐)
- 新增中文文档 `README.zh-CN.md`,与英文 README 互链

### Refactor / Tests
- 抽出 `src/cli/wiring.ts`(`registerGitTools` / `registerTaskTools` / `registerCronTools`),为 1100+ 行的 `cli.ts` 入口瘦身
- task 单测改用 `os.tmpdir()` + `mkdtemp` + 清理,不再在仓库工作树留 `.floom-test-*` 产物;`.gitignore` 加防御行
- 测试数 506 → 577(新增软链逃逸、DNS 重绑定、响应体上限、Markdown 渲染、语法高亮、ESC 中断、@文件补全、!/# 前缀、折行行数、后台计数/状态栏、/retry 不自激等用例)

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
