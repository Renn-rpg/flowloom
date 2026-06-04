<p align="center">
  <img src="assets/logo.svg" alt="FlowLoom" width="180">
</p>

# DeepSeek FlowLoom

**一个开源、DeepSeek 原生的 agentic 编码 CLI —— 以零头成本对标 Claude Code。**

[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.12.0-blue)](https://github.com/Renn-rpg/deepseek-flowloom)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

> 🌐 **English** → [README.md](README.md) ｜ 中文 → 本文档

DeepSeek FlowLoom（命令 `floom`）是一个**专为 DeepSeek API 打造**的终端编码 agent。它能读写、编辑文件，执行 shell 命令，并编排**多 agent 工作流**——全部在你的终端里完成。可以把它理解成 Claude Code，但**原生面向 DeepSeek、完全开源**。

```
$ floom "给 auth 模块加单元测试"

  → 读取 src/auth.ts
  → 写入 src/auth.test.ts
  → 运行 npm test
  → 修复一个失败断言
  ✅ 完成。调用 3 个工具,用了 1,247 tokens。
```

---

## 为什么选 FlowLoom?

| | Claude Code | FlowLoom |
|---|---|---|
| 模型 | Claude(Anthropic API) | **DeepSeek**(OpenAI 兼容) |
| 价格 | $15/M tokens(Claude) | **显著更便宜** —— 见 [DeepSeek 定价](https://api-docs.deepseek.com/quick_start/pricing) |
| 工作流引擎 | Dynamic Workflow | **Dynamic Workflow**(图灵完备的 JS 脚本) |
| 开源 | ❌ | ✅ MIT |
| 前缀缓存 | ✅ | ✅ 自动(DeepSeek 内置) |

---

## 快速开始

```bash
# 前置:Node.js >= 24
node --version  # v24.15.0+

# 安装
git clone https://github.com/Renn-rpg/flowloom.git
cd flowloom
npm install && npm run build

# 配置 DeepSeek API key
echo "DEEPSEEK_API_KEY=sk-你的-key" > .env

# 第一个任务
npm run dev -- "读取 package.json 并总结这个项目"

# 交互模式
npm run dev
```

**无原生模块、无 node-gyp、无需 Visual Studio。**

---

## 核心特性

### 🧠 Agentic 编码循环

FlowLoom 会迭代:读文件 → 找问题 → 调用工具 → 汇报。每个 turn 最多 25 轮多步循环,自动决定该用哪个工具。

### 🔧 内置工具

| 工具 | 说明 |
|---|---|
| `read_file` / `write_file` / `edit_file` / `multi_edit` | 读 / 写(自动建目录) / 精确唯一替换 / 单文件多处替换 |
| `run_shell`（+ `bash_output` / `kill_shell`） | 执行命令(Windows 用 pwsh,其它用 bash);`background:true` 跑长任务 |
| `glob` / `grep` | 按文件名找文件 / 按内容搜索(ripgrep 风格正则) |
| `web_fetch` / `web_search` | 按 URL 抓取页面为文本 / 不知道 URL 时搜索发现页面 |
| `dispatch_agent` | 把自包含子任务派发给隔离的[子 agent](docs/subagents.md) |
| `git_*`（17 个） | diff / status / log / commit / branch / stash / worktree / push / pull / merge / rebase / reset / revert / blame / tag / bisect / fetch |
| `task_*` / `cron_*` / `remember` | 任务跟踪 / 定时任务 / 持久记忆 |

外加 **MCP 工具**:通过 `.floom/mcp.json` 连接外部 [Model Context Protocol](docs/mcp.md) 服务,其工具会以 `mcp__<server>__<tool>` 出现给 agent。

### 🔄 Dynamic Workflow 引擎

用 **JavaScript 脚本**编排多个 agent:

```js
// audit.mjs
export const meta = { name: 'security-audit', schemaVersion: 1 }

export async function run(ctx) {
  ctx.phase('扫描')
  const files = await ctx.agent('列出 src/ 下所有源文件')

  ctx.phase('审计')
  const results = await ctx.parallel(
    files.split('\n').map(f => () =>
      ctx.agent(`审计 ${f} 的 SQL 注入 / XSS / 权限绕过`)
    )
  )
  ctx.log(`审计了 ${results.filter(Boolean).length} 个文件`)
  return results
}
```

```bash
floom run audit.mjs --budget 500000
```

**DSL 原语**:`agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / `workflow`(支持嵌套子工作流)。

### ⚡ 流式与交互体验

实时逐 token 流式输出。最终答案在终端按 **Markdown 渲染**(标题/列表/引用/强调),代码块带**语法高亮**。输入 **`@`** 弹出文件/目录选择器、在句中引用路径(`@src/cli.ts`)。响应过程中随时按 **`ESC`** 即可中止本轮、退回提示符;`Ctrl-O` 展开折叠的细节。

REPL 行首前缀:**`!命令`** 直接跑 shell(透传)、**`#笔记`** 存为持久记忆、**`@路径`** 引用文件。

### 💾 确定性 Resume

工作流运行会落盘到 SQLite。**相同脚本 + 相同参数 = 100% 命中缓存**:

```bash
$ floom run audit.mjs   # live=5  cached=0
$ floom run audit.mjs   # live=0  cached=5 ← 秒回!
```

### 🛡️ 生产级健壮性

- **指数退避重试** —— 429/5xx/网络错误
- **空闲超时** —— 流式请求按 chunk 间隔计时,稳定长输出不会被误杀
- **Token 预算硬上限** —— 预检 + `BudgetExhaustedError`
- **并发限流** —— 信号量,默认 `max(1, min(16, 核数-2))`
- **Agent 数量上限** —— 每个工作流 1000 个

### 🔒 安全防护

- **路径限界** —— 文件工具默认限定在项目根目录内;`../`、跨盘符、**项目内软链指向项目外**均被拦截
- **敏感文件防护** —— `.env` / 私钥 / 凭据文件默认拒读(`--yolo` 可绕过)
- **SSRF 防护** —— `web_fetch` 拦截私有/环回/链路本地地址、八进制/十六进制/十进制 IP、云元数据,逐跳复检重定向,并做 **DNS 解析后 IP 校验**(防 DNS 重绑定)
- **PreToolUse / PostToolUse Hooks** —— `.floom/hooks.json` 用 allow/deny/ask 在工具执行前后做策略门控
- **计划模式** —— 只读调研 → 提交计划 → 批准后才解锁改动(`/plan` 或 `--plan`)
- **审计日志** —— 每次 deny/ask 决策记录到 `.floom/permissions.log`

### 📊 成本可见

每个 turn 往 stderr 打印用量:`[usage] in=7536 out=394 cacheHit=4736`。DeepSeek 的**自动前缀缓存**会被检测并报告。

---

## 架构:核心不变式

内部一律使用 **"Anthropic 风格"** 的统一表示(`src/protocol/types.ts`)。OpenAI/DeepSeek 的协议细节**只允许**出现在两个地方:

- `src/protocol/*`(出向/入向转换、容错 JSON 解析)
- `src/model/deepseek-client.ts`(唯一 `import OpenAI` 的文件)

**`src/agent/`、`src/tools/`、`src/cli.ts` 永远不感知任何 OpenAI/DeepSeek 形状。** 加新模型 = 新写一个 `XxxClient implements ModelClient`,其余层零改动。

```
┌─────────────────────────────────────────────┐
│  CLI (cli.ts)                                │
│  floom "task" | floom run script.mjs        │
├─────────────────────────────────────────────┤
│  Agent Loop (agent/loop.ts)                  │
│  会话 ↔ 多轮 ↔ 工具执行                       │
├────────────────────┬────────────────────────┤
│  Workflow 引擎     │  工具                    │
│  (workflow/*)      │  read/write/edit/bash    │
│  • 运行时          │                          │
│  • Journal/SQLite  │                          │
│  • 信号量          │                          │
│  • 预算追踪        │                          │
├────────────────────┴────────────────────────┤
│  协议适配 (protocol/*)                        │
│  Anthropic 风格 ↔ OpenAI/DeepSeek wire        │
├─────────────────────────────────────────────┤
│  模型客户端 (model/deepseek-client.ts)        │
└─────────────────────────────────────────────┘
```

---

## CLI 参考

```bash
# 一次性任务
floom "给 src/utils.ts 加 JSDoc 注释"

# 交互 REPL(自然语言描述任务,agent 自选工具)
floom
floom> 给解析器加个单测并运行
floom> /help          # 输入 / 弹出命令菜单(方向键 + 回车)
floom> /exit

Agent 选项:
  -m, --model <id>       模型 ID(默认:deepseek-v4-pro)
  -e, --effort <level>   推理档位:high/max → 切到 thinking 模型
  --plan                 以计划模式启动(只读;先出计划再改动)
  --verbose              实时流式打印思考链(默认折叠,Ctrl+O 展开)
  --yolo                 关闭路径限界 + shell 确认
  -r, --resume [id]      恢复某个会话(无 id 则最近一个)
  -C, --cwd <dir>        指定项目目录
  --list-sessions        列出本项目已保存的会话

# Slash 命令:/help /model /effort /plan /clear /compact /usage /save /sessions /exit

# 工作流执行
floom run script.mjs [options]
  -b, --budget <n>       Token 预算(默认 1000000)
  -j, --journal <path>   Journal 数据库路径
  -a, --args <json>      传给脚本的 JSON 参数
  --workspace <dir>      自定义工作区目录
  --no-cleanup           执行后保留工作区
```

---

## 开发

```bash
npm install        # 安装依赖
npm test           # 跑全部 511 个测试(Vitest)
npm run test:watch # watch 模式
npm run dev        # tsx 热重载
npm run build      # 编译 TypeScript
npm run probe      # 工具调用可靠性压测(需真实 key)
```

**技术栈**:TypeScript(strict / ESM / NodeNext)、Vitest(TDD)、Commander、Zod、OpenAI SDK。

**工程约定**:相对 import 必须带 `.js` 扩展名;`src/workflow/*` 不得 import `openai`;模型相关代码只存在于 `protocol/*` 和 `model/deepseek-client.ts`。详见 `CLAUDE.md`。

---

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎 PR,尤其是:新工具实现、新模型后端(OpenAI / Groq 等)、`isolated-vm` 沙箱实现、文档与示例。

---

## License

MIT © 2026 FlowLoom Contributors
