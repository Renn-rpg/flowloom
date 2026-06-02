# Hooks（工具执行钩子）

FlowLoom 支持在**工具真正执行前**用用户声明的规则放行 / 拒绝 / 询问，作为独立于内置权限层（路径围栏、shell 确认、密钥防护）的一道策略闸。

## 配置

项目根目录下的 `.floom/hooks.json`（已被 `.gitignore` 忽略，是每个项目本地的策略）。无此文件 = 无规则 = 行为与不启用 hooks 完全一致。

```json
{
  "PreToolUse": [
    { "matcher": "run_shell", "inputMatcher": "rm\\s+-rf", "decision": "deny", "message": "拒绝破坏性 rm" },
    { "matcher": "run_shell", "decision": "ask" },
    { "matcher": "write_file|edit_file|multi_edit", "decision": "allow" },
    { "matcher": "web_fetch", "decision": "deny", "message": "本项目禁止联网抓取" }
  ]
}
```

### 规则字段（`PreToolUse[]`）

| 字段 | 必填 | 含义 |
|------|------|------|
| `matcher` | 否 | 工具名正则；缺省匹配任意工具（`.*`）。工具名：`read_file` `write_file` `edit_file` `multi_edit` `run_shell` `glob` `grep` `web_fetch` |
| `inputMatcher` | 否 | 对 `JSON.stringify(入参)` 的正则；用于按内容精确拦截（如只拦含 `rm -rf` 的 `run_shell`） |
| `decision` | 是 | `allow`（放行）/ `deny`（拦截）/ `ask`（方向键菜单确认） |
| `message` | 否 | `deny`/`ask` 时展示给你，并作为 tool error **回喂模型**，让模型知道被拦并自行调整 |

### 决策优先级

同一次工具调用命中多条规则时：**`deny` > `ask` > `allow` > 无命中**（最安全方向胜出）。无命中则交回内置权限层处理。

## 行为

- **deny**：工具不执行；模型收到 `ERROR: blocked by hook: <message>`，据此调整，而非静默失败。
- **ask**：暂停动画，弹方向键菜单（Yes / No）；非 TTY（管道/CI）下视为拒绝。
- 非法正则的规则会被**跳过**（不因坏配置误放或误拦）。
- `--yolo` **不**绕过 hooks——它是你显式声明的策略，应始终生效（与"关闭内置围栏"是两回事）。

## 实现

- 纯决策引擎：`src/hooks/engine.ts`（`evaluatePreToolUse` / `loadHooks`，模型与 UI 无关，单测覆盖）。
- 执行闸：`agent/loop.ts` 的 `ToolGate`（工具执行前调用，返回布尔 + 说明）。
- `cli.ts` 负责加载配置、把 `deny` 自动化、`ask` 接到方向键菜单。

> 命令型 hooks（运行外部脚本、`PostToolUse` 响应）为后续增量；当前为声明式 `PreToolUse`。
