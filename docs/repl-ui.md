# 交互式 REPL 体验（命令补全 + 详情折叠）

FlowLoom 的交互模式（`floom` 不带任务文本，或 `floom -r` 续接）用一个自建的 **raw-mode 行编辑器**取代了朴素的逐行读取，带来两项类 Claude Code 的体验：**斜杠命令下拉补全**与**思考详情折叠 / `Ctrl+O` 展开**。

> 仅在 **TTY** 下启用；管道 / CI（非 TTY）自动降级为普通逐行读取，行为与改造前完全一致。

## 1. 斜杠命令下拉补全

在 `floom>` 提示符敲 `/` 即弹出可用命令下拉，随输入实时过滤：

```
floom> /e
  ❯ /effort   show or set reasoning effort (high/max → thinking model)
    /exit     quit floom
```

| 按键 | 作用 |
|------|------|
| `↑` / `↓` | 在下拉项间移动高亮 |
| `Tab` | 把高亮项补全进输入行（不提交） |
| `Enter` | 高亮项 ≠ 当前输入 → 补全；已等于 → 直接执行 |
| `Esc` | 收起下拉（继续输入即重新弹出） |
| `←` `→` `Home`/`Ctrl+A` `End`/`Ctrl+E` `Backspace` `Delete` | 常规行内编辑 |

**二级参数子菜单**：对带可枚举参数的命令（目前 `/effort`），补全出命令后会进一步列出合法档位，方向键选定即可：

```
floom> /effort
  ❯ max     thinking model — deepest reasoning (FLOOM_REASONER_MODEL)
    high    thinking model — high reasoning
    normal  base model — no extra reasoning
```

档位语义与 `--effort` 一致（见 `effort.ts`）：`high`/`max` → 切到 `FLOOM_REASONER_MODEL` 指定的 thinking 模型；`normal` → 回到基础模型。

## 2. 思考详情折叠 / `Ctrl+O` 展开

默认（折叠模式）**不**流式打印模型的思考链（CoT，reasoning 模型才有），只保留计时与一行提示：

```
floom> 解释这段代码
  Thinking... (6.4s) · ctrl+o to expand
<最终答案……>
```

完整思考链被缓存。在提示符处按 **`Ctrl+O`** 即：
- 切换 verbose 开/关（影响后续轮次是否实时流式思考链）；
- 若刚切到「开」，立即就地**展开上一轮被折叠的思考链**。

```
floom>            ← 此处按 Ctrl+O
  ✻ verbose on — thinking will stream live
  ✻ last thinking:
    <上一轮完整 CoT……>
floom>
```

启动即想看全部思考链：加 `--verbose`（一次性模式同样适用，因其无交互、无法按 `Ctrl+O`）。

> 注意：`Ctrl+O` 仅在**提示符处**生效。turn 进行中终端处于非 raw 模式，`Ctrl+C` 仍可中断当前进程。

## 实现与边界

- `src/cli/completions.ts` —— `computeCompletions(buffer)` 纯函数，把输入映射成命令/参数补全项（零 IO，可单测）。
- `src/cli/repl-input.ts` —— `decodeKey`（按键解析）、`reduceKey`（纯状态机）、`ReplReader`（raw-mode IO 外壳）。前两者纯函数全覆盖单测；IO 外壳复刻 `prompt.ts` 中 `selectMenu` 的 stdin 接管/恢复模式。
- `src/cli.ts` —— `UiState{verbose,lastReasoning}` 贯穿 `runTurnWithUI`；`Ctrl+O` 经 `ReplReader` 的 `onToggleVerbose` 回调驱动。
- **架构不变式**：渲染层与模型无关——思考链经 `onReasoning`/`reasoningText`（模型无关）暴露，UI 仅决定显隐，不感知 DeepSeek/OpenAI 形状。

### 已知边界（后续增量）

- 行编辑假设输入在**单行**内。超长到换行的输入，下拉的光标定位可能不准（但仍可正常提交）。
- 粘贴若含换行，按**首行**提交（与多数 CLI 一致），其余丢弃。
- 命令历史（`↑` 调出上一条输入）尚未实现——`↑`/`↓` 当前仅用于下拉导航。
