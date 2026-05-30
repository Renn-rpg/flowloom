# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

FlowLoom（CLI 命令 `floom`）是一个**面向 DeepSeek、无限接近 Claude Code 的开源 agentic 编码 CLI**。最终目标是开源到 GitHub。DeepSeek 是 **OpenAI 兼容 API**（`base_url=https://api.deepseek.com`），**不是** Anthropic API。

## 常用命令

```bash
npm run dev -- "任务文本"     # tsx 直跑（开发期首选）；省略任务文本进入交互 REPL
npm run build                # tsc 编译到 dist/（floom 二进制 = dist/cli.js）
npm test                     # vitest run，跑全部单测
npm test -- retry            # 只跑文件名匹配 "retry" 的单测（单文件调试用这个）
npm run test:watch           # vitest watch
npm run probe                # tsx scripts/probe.ts，工具调用可靠性压测（需真实 key）
```

需要真实 DeepSeek key 的命令（`dev`/`probe`/端到端）：把 key 放进 **`.env`**（已 gitignore），通过 dotenv 加载。**绝不**把 key 打印到对话、提交进 git、或放进命令行参数。环境变量见 `.env.example`：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`。

## 架构：核心不变式

内部一律使用 **"Anthropic 风格"** 的统一表示（`src/protocol/types.ts`：`InternalMessage` / `ToolSpec` / `GenerateRequest` / `GenerateResult`）。OpenAI/DeepSeek 的协议细节**只允许**出现在两个地方：

- `src/protocol/*`（`to-openai.ts` 出向转换、`from-openai.ts` 入向转换、`safe-json.ts`）
- `src/model/deepseek-client.ts`（唯一 `import OpenAI` 的文件）

**`src/agent/`、`src/tools/`、`src/cli.ts` 永远不得 import openai，也不得感知任何 OpenAI/DeepSeek 形状。** 这是模型可替换性的根基——加新模型 = 新写一个 `XxxClient implements ModelClient`，其余层零改动。改代码时务必维持这条边界。

### 一次 turn 的数据流

`cli.ts` → `createSession`（`agent/loop.ts`，持有 `messages` 与累计 `usage`）→ `runTurn` 循环（上限 `maxIters=25`）：

1. 调 `client.generate(GenerateRequest, { onText })`
2. `DeepSeekClient.generate`：`toOpenAIRequest`（内部→wire）→ `withRetry(() => openai.chat.completions.create(..., { timeout }))` → `fromOpenAIResponse`（非流式）或 `StreamAccumulator`（流式，逐 chunk 回吐文本增量给 `onText`）→ 还原成内部 `GenerateResult`
3. 若 `stopReason === 'tool_use'`：对每个 toolCall 走 `registry.run(name, input)`，结果以 `role:'tool'` 消息回推，继续循环；否则返回文本，turn 结束

### 协议转换里的非显然映射（改 `protocol/*` 前必读）

- `system` → `messages[0]`（`role:'system'`）
- `ToolSpec.inputSchema` → `tools[].function.parameters`，整体包成 `{ type:'function', function:{...} }`
- assistant 的 `toolCalls` → `tool_calls`，其 `arguments` 必须 `JSON.stringify`（wire 上是字符串）
- 工具结果 → `role:'tool'` + `tool_call_id`；**OpenAI 无 `is_error` 字段**，错误用 content 前缀 `ERROR: ` 编码（`registry.run` 失败也返回 `ERROR:` 开头字符串，`loop.ts` 据此判定 `isError`）
- `finish_reason` 映射：`stop`→`end_turn`、`tool_calls`→`tool_use`、`length`→`max_tokens`
- **永不发送 `top_k`**（DeepSeek/OpenAI 会拒绝）
- 入向 `tool_calls[].function.arguments` 一律走 `safeParseArgs`（容错解析，补缺失右括号）
- `usage.prompt_cache_hit_tokens` → `cacheHitTokens`（DeepSeek 自动前缀缓存，已实测开启）
- 流式取 usage 必须带 `stream_options: { include_usage: true }`

### 工具系统

`Tool = { spec: ToolSpec, handler }`（`tools/types.ts`）。`ToolRegistry`（`tools/registry.ts`）做 register/get/specs/run，`run` 用 try/catch 把异常转成 `ERROR:` 字符串。现有 4 个工具：`read_file`、`write_file`（自动建目录）、`edit_file`（**精确且唯一**替换，命中 0 次或 >1 次都报错）、`run_shell`（win32 用 `pwsh -NoProfile -Command`，否则 `bash -c`，输出截断 10k）。

### 健壮性

`model/retry.ts` 的 `withRetry` 是**模型无关**通用件：指数退避，重试 429/5xx/无 HTTP 状态（网络/超时），其它 4xx 不重试。`DeepSeekClient` 关掉了 SDK 自带重试（`maxRetries:0`）改用它；per-request `timeout` 默认 60s。用量/缓存命中在 `AgentSession.usage` 累计，`cli.ts` 每轮往 **stderr** 打 `[usage] in=.. out=.. cacheHit=..`（不污染 stdout，契合"成本可见"卖点）。

## 工程约定

- **ESM + NodeNext**：相对 import **必须带 `.js` 扩展名**（如 `import ... from './types.js'`），即便源文件是 `.ts`。漏写会编译/运行失败。
- **TDD**：每个模块旁边有同名 `*.test.ts`（vitest）。`tsconfig.json` 与 `vitest.config.ts` 都把测试限定在 `src/**/*.test.ts`，`build` 时被 `exclude` 排除——`dist/` 不含测试。新增功能按红-绿节奏走。
- **不臆造 DeepSeek 数字**：context 长度、max output、并发额度（429 阈值）等一律不硬编码，全部走 `.env`/配置。`docs/deepseek-fact-check.md` 是所有模型相关默认值的**唯一依据**——拿到实测结论先更新它。已确认事实：`deepseek-chat` 可用、工具调用 JSON 可靠（压测 0% 坏 JSON，故 `safeParseArgs` 刻意保持轻量、不做重型修复管线）、未观察到并行工具调用、自动前缀缓存默认开启。

## Git

flowloom 是独立 git 仓库（嵌套在非 git 的父目录 `Desktop\1` 内）。提交粒度小、message 用 `type(scope): ...`（如 `feat(model): ...`）。里程碑 tag：`mvp-0.1` → `phase2-0.2` → `phase2.5-0.3`。下一步是阶段 3：Dynamic Workflow 引擎（isolated-vm 沙箱 + `agent/parallel/pipeline/phase` DSL + journal/resume + 预算）。
