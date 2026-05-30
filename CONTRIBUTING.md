# Contributing to FlowLoom

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/user/flowloom.git
cd flowloom
npm install
npm test  # 100 tests should pass
```

## Development Workflow

1. **Find an issue** or create one describing what you want to work on
2. **Branch** from `main`: `git checkout -b feat/my-feature`
3. **Write tests first** (TDD): create `*.test.ts` next to your module
4. **Implement** with passing tests: `npm test`
5. **Build check**: `npm run build` (zero TypeScript errors)
6. **Commit**: use `type(scope): description` format
7. **PR**: describe what, why, and how to test

## Architecture Rules

These are **non-negotiable** — PRs that break them will be asked to fix:

1. **`src/workflow/*` must never `import 'openai'`.** Model access goes through the `ModelClient` interface.
2. **Model-specific code lives only in `src/protocol/*` and `src/model/deepseek-client.ts`.**
3. **Relative imports use `.js` extension** (`import { x } from './foo.js'`), even for `.ts` files.
4. **Internal types use "Anthropic style"** (`InternalMessage`, `ToolSpec`, `GenerateRequest`, `GenerateResult` from `src/protocol/types.ts`).

Read `CLAUDE.md` for the full architecture guide.

## Where to Contribute

### Good First Issues
- Add a new tool (`grep_file`, `glob_search`, `web_fetch`, etc.)
- Improve error messages
- Add test coverage for edge cases

### Intermediate
- Implement a new model backend (`OpenAIClient`, `GroqClient`) following the `ModelClient` interface
- Create workflow example scripts in `scripts/examples/`
- Improve CLI output formatting

### Advanced
- Implement `IsolatedVmRuntime` (in `src/workflow/sandbox.ts`) using the `isolated-vm` package
- Add `worker_threads` concurrency model
- Implement MCP (Model Context Protocol) tool loading

## Commit Convention

```
type(scope): description

feat(workflow): add X
fix(cli): fix Y
docs: update README
test(tools): add tests for Z
```

## Running Tests

```bash
npm test                # All tests
npm test -- hash        # Specific module
npm run test:watch      # Watch mode
npm run probe           # DeepSeek API reliability probe (needs key)
```

## Questions?

Open a Discussion or issue on GitHub.
