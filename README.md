<p align="center">
  <img src="assets/logo.svg" alt="FlowLoom" width="180">
</p>

# FlowLoom

**An open-source, DeepSeek-native agentic coding CLI —— infinitely close to Claude Code.**

[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

FlowLoom (`floom`) is a terminal-based coding agent built for **DeepSeek**. It reads, writes, edits files, runs shell commands, and orchestrates **multi-agent workflows** — all from your terminal. Think of it as Claude Code, but native to the DeepSeek API.

```
$ floom "Add unit tests for the auth module"

  → reads src/auth.ts
  → writes src/auth.test.ts
  → runs npm test
  → fixes a failing assertion
  ✅ Done. 3 tools called, 1,247 tokens used.
```

---

## Why FlowLoom?

| | Claude Code | FlowLoom |
|---|---|---|
| Model | Claude (Anthropic API) | **DeepSeek** (OpenAI-compatible) |
| Price | $15/M tokens | **$0.28/M tokens** (53x cheaper) |
| Max context | 200K | Up to 1M (DeepSeek) |
| Workflow engine | Dynamic Workflow | **Dynamic Workflow** (Turing-complete) |
| Open source | ❌ | ✅ MIT |
| Prefix caching | ✅ | ✅ Auto (DeepSeek built-in) |

---

## Quick Start

```bash
# Prerequisites: Node.js >= 24
node --version  # v24.15.0+

# Install
git clone https://github.com/user/flowloom.git
cd flowloom
npm install && npm run build

# Set your DeepSeek API key
echo "DEEPSEEK_API_KEY=sk-your-key-here" > .env

# Your first task
npm run dev -- "Read package.json and summarize this project"

# Interactive mode
npm run dev
```

**No native modules, no node-gyp, no Visual Studio required.**

### 30-Second Demo

```bash
# Run the built-in audit workflow
$ floom run scripts/examples/audit.mjs --sandbox vm --budget 200000

[phase] Discovery
  Scanning project structure...

[phase] Audit
  Found files to audit. Starting parallel review...
  Audit complete. 3/3 files reviewed.

[usage] budget=193957/200000 live=4 cached=0
{
  "filesReviewed": 3,
  "results": [
    "Missing error handling: workflow-runtime.ts silent catch {...},
     potential null dereference at priorCalls[seq]...",
    "No missing .js extensions found in imports...",
    "All imports correctly use .js extension pattern..."
  ]
}
```

The workflow spawns **4 agents in parallel**: one discovers files, three audit them simultaneously. Token cost: ~194K tokens (~$0.05 at DeepSeek pricing).

---

## Features

### 🧠 Agentic Coding Loop

```
floom> Find all TODOs in the codebase and create GitHub issues for each
```

FlowLoom iterates: reads files → finds TODOs → calls GitHub API → reports. Multi-turn loop with up to 25 iterations per turn.

### 🔧 Built-in Tools

| Tool | Description |
|---|---|
| `read_file` | Read UTF-8 text files |
| `write_file` | Write files (auto-creates directories) |
| `edit_file` | Exact, unique string replacement |
| `run_shell` | Execute shell commands (pwsh on Windows, bash elsewhere) |

### 🔄 Dynamic Workflow Engine

Write **JavaScript workflow scripts** that orchestrate multiple agents:

```js
// audit.mjs
export const meta = { name: 'security-audit', schemaVersion: 1 }

export async function run(ctx) {
  ctx.phase('Scanning')
  const files = await ctx.agent('List all source files in src/')

  ctx.phase('Auditing')
  const results = await ctx.parallel(
    files.split('\n').map(f => () =>
      ctx.agent(`Audit ${f} for SQL injection, XSS, and auth bypass`)
    )
  )

  ctx.log(`Audited ${results.filter(Boolean).length} files`)
  return results
}
```

```bash
floom run audit.mjs --budget 500000 --sandbox vm
```

**Workflow DSL primitives:**
- `agent(prompt, opts?)` — spawn a sub-agent
- `parallel(thunks)` — run thunks concurrently
- `pipeline(items, ...stages)` — process items through stages
- `phase(title)` / `log(msg)` — progress output
- `budget` — token cost tracking and limits

### ⚡ Streaming & Responsiveness

Real-time token streaming via `onText` callback. See the model think as it works.

### 🛡️ Production Hardening

- **Exponential backoff retry** — 429/5xx/network errors, configurable
- **Per-request timeout** — default 60s, prevents hanging
- **Token budget enforcement** — hard cap with pre-check, `BudgetExhaustedError`
- **Concurrency limiter** — `min(16, cores-2)` Semaphore
- **Agent count cap** — 1000 per workflow

### 📊 Cost Visibility

Every turn prints token usage to stderr:

```
[usage] in=7536 out=394 cacheHit=4736
```

DeepSeek's **automatic prefix caching** is detected and reported, so you know exactly how much you save.

### 💾 Deterministic Resume

Workflow runs are journaled to SQLite. **Identical script + args = 100% cache hit**:

```bash
$ floom run audit.mjs              # live=5, cached=0
$ floom run audit.mjs              # live=0, cached=5 ← instant!
```

### 🏖️ Sandboxed Execution

```
$ floom run script.mjs --sandbox vm
```

The `vm` sandbox blocks non-deterministic APIs (`Date.now()`, `Math.random()`, `new Date()` without args), ensuring reproducible workflow runs.

### 🔒 Workspace Isolation

Every workflow run gets a temporary directory. File operations stay inside. Absolute paths and `../` escape attempts are rejected.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  CLI (cli.ts)                                │
│  floom "task" | floom run script.mjs        │
├─────────────────────────────────────────────┤
│  Agent Loop (agent/loop.ts)                  │
│  Session ↔ Multi-turn ↔ Tool execution      │
├────────────────────┬────────────────────────┤
│  Workflow Engine   │  Tools                  │
│  (workflow/*)      │  read/write/edit/bash   │
│  • Runtime         │                         │
│  • Journal/SQLite  │                         │
│  • Semaphore       │                         │
│  • Budget Tracker  │                         │
├────────────────────┴────────────────────────┤
│  Protocol Adapter (protocol/*)               │
│  Anthropic-style ↔ OpenAI/DeepSeek wire      │
├─────────────────────────────────────────────┤
│  Model Client (model/deepseek-client.ts)     │
│  OpenAI SDK ↔ DeepSeek API                   │
└─────────────────────────────────────────────┘
```

**Core invariant:** Only `protocol/*` and `model/deepseek-client.ts` know about OpenAI/DeepSeek shapes. The agent, tools, and workflow engine operate on an Anthropic-style internal representation. Swap the model by implementing `ModelClient`.

---

## CLI Reference

```bash
# Single-shot task
floom "Add JSDoc comments to src/utils.ts"

# Interactive REPL
floom
floom> read_file src/index.ts
floom> /exit

# Workflow execution
floom run script.mjs [options]

Options:
  -m, --model <id>      Model ID (default: deepseek-v4-pro)
  -b, --budget <n>       Token budget (default: 1000000)
  -j, --journal <path>   Journal database path (default: .floom/journal.db)
  -a, --args <json>      JSON args passed to script (default: {})
  --sandbox <type>       Sandbox: vm (default) | isolated (stub)
  --workspace <dir>      Custom workspace directory
  --no-cleanup           Keep workspace after execution
```

---

## DeepSeek Reliability

We ran a 10-task **tool-calling probe** against the DeepSeek API before building. Results:

| Metric | Result |
|---|---|
| Valid JSON in tool arguments | **10/10 (100%)** |
| Hallucinated schema fields | **0/10 (0%)** |
| Parallel tool calls | 0/10 (DeepSeek does one at a time) |
| Auto prefix caching | ✅ Detected & reported |

This refuted a pessimistic research report that assumed 80-90% JSON reliability. DeepSeek's tool calling is production-grade.

---

## Development

```bash
npm install        # Install dependencies
npm test           # Run 100 tests (Vitest)
npm run test:watch # Watch mode
npm run dev        # tsx hot-reload
npm run build      # Compile TypeScript
npm run probe      # Tool-calling reliability probe (needs API key)
```

**Tech stack:** TypeScript (strict, ESM, NodeNext), Vitest (TDD), Commander, Zod, OpenAI SDK.

**Architecture rules:**
- Relative imports use `.js` extension (NodeNext)
- `src/workflow/*` never imports `openai`
- Model-specific code lives only in `protocol/*` and `model/deepseek-client.ts`
- See `CLAUDE.md` for the full architecture guide

---

## Roadmap

| Phase | Status | What |
|---|---|---|
| MVP | ✅ | 4 tools, single-turn agent |
| Phase 2 | ✅ | Streaming, multi-turn REPL, edit tool |
| Phase 2.5 | ✅ | Retry, timeout, usage/cache visibility |
| Phase 3a | ✅ | Canonical hash, SQLite journal, vm sandbox, agent executor, resume |
| Phase 3b | ✅ | Semaphore, budget enforcement, nested workflow, `floom run` CLI |
| Phase 3c | ✅ | Sandbox integration, workspace isolation, import cache fix |
| Phase 4 | 🚧 | Open-source release (README, logo, docs) |
| Phase 5 | 📋 | Prompt caching optimization, MCP support |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — especially:
- New tool implementations (grep, glob, web search, etc.)
- Additional model backends (OpenAI, Groq, etc.)
- `isolated-vm` Runtime implementation
- Documentation & examples

---

## License

MIT © 2026 FlowLoom Contributors
