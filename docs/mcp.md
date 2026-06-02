# MCP 客户端（接外部工具生态）

FlowLoom 内置一个最小 **MCP（Model Context Protocol）客户端**，可连接外部 MCP server（stdio 传输），把它们暴露的工具像内置工具一样交给 agent 使用。这让 FlowLoom 接入 MCP 生态（文件系统、数据库、搜索、GitHub 等社区 server）。

## 配置

项目根目录的 `.floom/mcp.json`，沿用 Claude Desktop / Claude Code 的 `mcpServers` 形状（已 gitignore）。无此文件 = 不连接任何 server = 零行为变化、零额外进程。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/you/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "cwd": "C:/some/dir",
      "disabled": false
    }
  }
}
```

| 字段 | 必填 | 含义 |
|------|------|------|
| `command` | 是 | 启动 server 的可执行（`npx` / `node` / 绝对路径）。**Windows 上 args 里的路径建议用正斜杠或绝对路径** |
| `args` | 否 | 参数数组 |
| `env` | 否 | 追加的环境变量（与当前进程环境合并；密钥放这里，别进 git） |
| `cwd` | 否 | server 的工作目录 |
| `disabled` | 否 | `true` 则跳过该 server |

## 运行时行为

- 启动时连接所有 server，打印 `⌁ MCP <name>: N tool(s)`；单个 server 失败（命令不存在 / 握手失败 / 超时）只打一行 `⚠` 并跳过,**不影响 floom 启动**。
- MCP 工具以 `mcp__<server>__<tool>` 命名（非法字符转 `_`）注册进工具表,模型可直接调用。
- `tools/call` 的 `content[]` 被拍平为文本回喂模型;`isError:true` 加 `ERROR:` 前缀。
- 退出（`/exit` 或一次性跑完）时按 spec 关停 server 子进程（关 stdin → 等退出 → SIGTERM）。

## 协议（实现依据，带 spec 引用）

按官方 spec `modelcontextprotocol.io/specification/2025-06-18`（核验见 `docs/deepseek-fact-check` 同款流程）：

- **JSON-RPC 2.0**;**stdio = 换行分隔的紧凑 JSON**,无 Content-Length 头,stdout 仅 MCP 消息,stderr 仅日志（不当错误）。
- 握手三步:`initialize`(protocolVersion `2025-06-18`、capabilities、clientInfo)→ 收 result(serverInfo/capabilities)→ 发通知 `notifications/initialized`。版本差异容忍。
- `tools/list`(支持 `nextCursor` 分页)→ `tools/call {name, arguments}`。

## 实现与边界

- `src/mcp/protocol.ts` 帧编解码、`client.ts` 客户端(传输注入,可单测)、`transport.ts` stdio 子进程传输、`adapter.ts` MCP→FlowLoom Tool、`config.ts` 配置、`manager.ts` 连接编排。
- **架构不变式**:MCP 是独立外部协议,只活在 `src/mcp/*`;通过把 MCP 工具适配成标准 `Tool` 注册进 registry,`agent/` 与 loop **完全不感知 MCP**,与"不得 import openai"同理。

> 当前支持 **stdio** 传输与 **tools**。Streamable HTTP 传输、resources/prompts、`tools/list_changed` 热更新为后续增量。
