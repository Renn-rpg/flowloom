# DeepSeek FlowLoom 中文说明

DeepSeek FlowLoom (`floom`) 是一个面向 **DeepSeek** 的开源 agentic 编码 CLI，媲美 Claude Code 体验，成本仅为其一小部分。

## 快速开始

```bash
# 要求 Node.js >= 24
git clone https://github.com/Renn-rpg/deepseek-flowloom.git
cd flowloom
npm install && npm run build

# 配置 DeepSeek API Key
echo "DEEPSEEK_API_KEY=sk-你的key" > .env

# 单次任务
npm run dev -- "帮我给 src/utils.ts 添加 JSDoc 注释"

# 交互模式
npm run dev
```

## 核心功能

- 🧠 **Agent 循环**: 多轮工具调用，最多 25 次迭代，流式响应
- 🔧 **22+ 内置工具**: 文件读写编辑、Shell 执行、搜索、Git 操作、Web 搜索
- 🔄 **Dynamic Workflow 引擎**: 多 agent 编排、确定性 resume、SQLite journal
- 📋 **计划模式**: 只读调研 → 提交计划 → 批准后执行
- 🪝 **Hook 系统**: PreToolUse + PostToolUse，工具执行前后可拦截/回调
- 🧩 **MCP 集成**: stdio transport + JSON-RPC，连接外部工具服务
- 🧠 **记忆系统**: 跨会话记住用户偏好和项目约定
- ⚡ **技能系统**: `/code-review` `/simplify` `/architect` 一键调用
- ⏰ **Cron 定时任务**: 定时/周期性触发 agent 任务
- 🛡️ **安全防护**: 路径围栏、密钥保护、SSRF 防御、权限分级

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/model [id]` | 切换模型 |
| `/effort [level]` | 推理深度 (high/max) |
| `/plan` | 切换计划模式 |
| `/clear` | 清空对话历史 |
| `/usage` | 查看 Token 用量 |
| `/save` | 保存当前会话 |
| `/memory` | 查看持久化记忆 |
| `/config` | 查看生效配置 |
| `/code-review` | 代码审查 |
| `/simplify` | 代码简化建议 |
| `/architect` | 架构咨询 |
| `/exit` | 退出 |

## 工作流

```bash
# 运行预置工作流
floom run scripts/workflows/audit.mjs --budget 500000
floom run scripts/workflows/review.mjs
floom run scripts/workflows/refactor.mjs --args '{"task":"重构认证模块"}'
floom run scripts/workflows/onboard.mjs
```

## 与 Claude Code 对比

| | Claude Code | FlowLoom |
|---|---|---|
| 模型 | Claude (Anthropic) | **DeepSeek** (OpenAI 兼容) |
| 开源 | ❌ | ✅ MIT |
| 价格 | $15/M tokens | **显著更低** |
| 记忆系统 | ✅ | ✅ |
| 技能系统 | ✅ | ✅ |
| 工作流引擎 | ✅ | ✅ |
| 定时任务 | ✅ | ✅ |
| Git 工具 | ✅ | ✅ |
| 中文支持 | 一般 | **原生优化** |
| 确定性 Workflow | ❌ | ✅ |

## 更多文档

- [架构说明](../../CLAUDE.md)
- [Hook 系统](../hooks.md)
- [MCP 集成](../mcp.md)
- [计划模式](../plan-mode.md)
- [子 Agent](../subagents.md)
