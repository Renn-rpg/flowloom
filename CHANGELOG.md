# Changelog

## [0.14.1] — .env 加载时序修复

### Bug Fixes
- **`.env` 覆盖对 import 期环境常量不生效**:`session-factory` 的 `CONTEXT_TOKENS` / `MAX_TOKENS` / `REASONER_MODEL` 在 import 期求值,而 dotenv `config()` 原先写在 `cli.ts` 模块体里、按 ESM 规则晚于所有 import → 这些常量读不到 `.env`(只有真 shell env 生效)。抽出副作用模块 `src/load-env.ts` 并作为 cli 的**首个 import**,保证 `.env` 先于任何环境常量求值。默认值(含 1M 上下文)不受影响;修复后 `.env` 里设这些变量可真正覆盖。集成验证:临时 `.env`,正确顺序读到覆盖值、错误顺序回退默认。

## [0.14.0] — parallel sub-agents, live panel & drill-in

### Features
- **`dispatch_agents` 并发扇出工具**(`src/agent/dispatch-many.ts`):对话内一次派出 N 个**并发**子 agent(`Promise.all` + 复用 `workflow/concurrency.ts` 的 `Semaphore`/`defaultConcurrency`),各跑一个独立子任务、结果按提交序聚合、单个失败隔离。强烈优于连续多次 `dispatch_agent`。system prompt 增指引
- **中心化 `AgentTracker`**(`src/cli/agent-tracker.ts`):多 agent 运行态唯一真相源(每 agent:label/phase/model/status/tokens/tools/elapsed),`EventEmitter` 'update' 驱动 UI;纯数据可单测。dispatch_agent / dispatch_agents / workflow / `floom run` 全部喂它
- **常驻底部面板:输入框 + 状态行(上) + 模式行(下)**(`src/cli/footer.ts` + `src/cli/repl-input.ts`):对标 Claude Code 的常驻区,**任何时候都在**(含模型回答时),状态行在上、模式行在下、两行分开。
  - 输入态:`ReplReader` 把状态/模式行**内联**画在输入框正下方(`panelLines` 每帧重算 → 切模式即时反映),随框一起被 `\x1b[J` 清/重绘 → 任意终端都「永久可见、不只输出时出现」
  - 输出态:装上 **DECSTBM 滚动区页脚**(`composeFooter`:静态输入框 + `⟳ k/N agents` 运行摘要? + 状态行 + 模式行),正文在其上方滚动 → 对话框在模型回答时也常驻
  - **状态行进度条式**(清新蓝/青绿,无 emoji):`<模型> (<窗口>)  │  ctx <进度条> <pct>% <用量>/<窗口>`——模型名清新蓝、窗口柔青、ctx 占用条 <70% 绿 / 70%+ 黄 / 90%+ 珊瑚红;effort/bg 仅在存在时追加。模式行配色:`auto-accept` 黄、`plan` 蓝、`normal` 白
  - `composeStatusLine`/`composeModeLine`/`composeRunLine`/`composeBox` 纯函数可单测;`supportsFooter` 放宽到**任意 win32 TTY**(现代 conhost 也支持 DECSTBM,不再只认 WT/vscode → 普通 PowerShell 控制台也有面板);底部空间按最高面板**一次性**预留(`pushed`),涨缩绝不在流式途中注入换行;DECSC/DECRC 原位重绘、resize 自适应、每轮装/撤、所有退出路径复位 `\x1b[r`
- **Shift+Tab 三态模式**:`normal`(shell 逐条确认)→ `auto-accept`(shell 自动放行)→ `plan`(只读、先出计划)循环。`decodeKey` 加 `\x1b[Z`、`reduceKey` 出 `cycle-mode`、`ReplReader` 走 `onCycleMode`;`makeInteractiveShell` 读 `isAuto` 断言
- **↓ 钻入详情视图**(`src/cli/workflow-view.ts`):运行中按 ↓ 进 alt-screen 全屏看每个子 agent 的 model/tokens/工具数/耗时/状态,`↑↓` 选 · `x` 停 · `p` 暂停/恢复 · `s` 存档(`.floom/runs/`)· `esc` 返回;`renderWorkflowView`/`reduceView` 纯函数可单测。`/workflows` 回看最近一次运行
- **对话内 `workflow` 工具**(`src/workflow/workflow-tool.ts`,**仅 --yolo**):模型用 JS 脚本编排多阶段(phase/parallel/pipeline/budget)工作流,进度进面板/钻入。脚本经临时文件 + `NodeVmRuntime` 执行
- **`floom run` 复用渲染**:TTY 下进度事件喂 tracker,打印分组实时行 + 跑完一张每 agent 汇总表;非 TTY 保留扁平 stderr(CI 行为不变)

### Engine
- `WorkflowRunOptions` 增 `onEvent`(结构化进度事件 `phase|agent-start|agent-tool|agent-usage|agent-done|log`)、`signal`(x stop 贯穿 runTurn)、`isPaused`/`waitForResume`(p pause 的归还-等待-重抢闸)。`AgentExecutor.agent` 增 hooks(onToolCall + signal)
- 有 `onEvent` 时引擎抑制 per-agent stderr 流与开跑横幅(由 UI 渲染),仍保留最终 `[usage]` 行

### Security
- 对话内 `workflow` 工具**仅在 --yolo 注册**:脚本顶层以 Node 权限运行、`run(ctx)` 走 node:vm(非安全沙箱),等价任意代码执行、会绕过路径限界/shell 审批——受限模式下模型改用受策略约束的 `dispatch_agents`
- `dispatch_agents` 子 agent 沿用受限路径策略 + shell 闸,且**不含任何 dispatch_***(递归隔离);`auto-accept` 仅在用户显式 Shift+Tab 切入时放行 shell

### Bug Fixes（交互层，发布前两轮对抗式复审 + 实测修复）
- **↓ 进钻入视图会吞掉流式文本**:① ↓ 现在**仅在有活动并行 run 时**才进视图(普通流式不再误开 alt-screen);② 新增 runTurn `beforeGenerate` 闸——视图打开期间挂起模型下一次 generate,等关闭再继续,杜绝「扇出跑完后续输出写进 alt 缓冲被丢」
- **Shift+Tab 在模型输出途中失灵**:`watchInterrupt` 现在也识别 `\x1b[Z`(及 ↓/ESC),输出途中可切模式
- **ESC 打断未停并行子 agent**:ESC 现在同时 `activeRunControl.stop()`,子 agent 立即收到中断信号
- **split-escape 误触**:`watchInterrupt` 对单字节 ESC 加 12ms 合并缓冲(同 questionTTY),拆分的 `\x1b[Z`/`\x1b[B` 不再被误当 ESC 打断
- **暂停后中止会挂死**:`stop` 现在同时唤醒暂停中的子 agent(清 paused + 排空 resumers),否则它们永远卡在 `waitForResume` 导致 turn 挂死
- **Ctrl-C 在钻入视图里失效**:raw 模式无自动 SIGINT,视图现在把 Ctrl-C 也当 esc(始终可退出)
- **页脚 resize 鲁棒性**:`onResize` 在 alt-screen 挂起期间不动主屏;`resume` 按当前高度强制重设滚动区;腾底部空间只在首次 install 做一次(避免每次 resize 行数蠕变)
- **钻入视图渲染异常会卡住光标**:`draw` 包 try/catch 兜底退出、`finish` 幂等,异常时也能还原光标 + 退出 alt-screen + 交还 stdin
- **「Shift+Tab 切模式像没反应」**(用户实测):根因有二——① 提示符在整行读取期只求值一次(切换后不重绘),② `supportsFooter` 只认 WT/vscode,普通 PowerShell 控制台拿不到页脚 → 模式行根本不显示。修复:提示符每帧重算 + 放宽 `supportsFooter` 到任意 win32 TTY + 模式行常驻于框下方,输入/输出两态切换都即时可见
- **状态/模式只在模型输出时才出现**(用户实测):根因是行编辑器的 `\x1b[J` 每次按键都擦掉滚动区页脚 → 输入态页脚被清空。改为输入态由 `ReplReader` 内联画状态/模式行(随框一起清/重绘),不再依赖会被擦掉的页脚;模式从提示符里移除,只在框下方显示

### Tests
- 测试数 → 640(新增 agent-tracker / dispatch-many(并发上限、中断、**暂停-中止不挂死**)/ footer(两行布局、静态框、conhost 判据、`composeStatusLine`/`composeModeLine`/`composeBox`)/ workflow-view(含 ctrl-c 退出)/ workflow-tool / runTurn beforeGenerate 闸 / decodeKey shift-tab / reduceKey cycle-mode / ReplReader `panelLines` 内联面板逐帧重算 / makeInteractiveShell auto-accept)

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
