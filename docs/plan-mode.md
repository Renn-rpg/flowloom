# 计划模式（Plan Mode）

计划模式让 agent **先只读调研、产出计划、经你批准后再动手**——避免它在你还没看清意图时就改文件 / 跑命令。对应 Claude Code 的 Plan Mode。

## 开启 / 关闭

- 启动即开:`floom --plan`
- REPL 里切换:`/plan`(再按一次关闭)
- 开启时提示符变为 `floom(plan)>`,并有一行 `✦ plan mode ON` 提示。

> 计划模式仅在**交互模式**有意义(一次性 `floom "task"` 不启用)。

## 行为

计划模式下:

- **只放行只读工具**:`read_file` / `glob` / `grep` / `web_fetch`。
- **拦截一切有副作用的工具**:`write_file` / `edit_file` / `multi_edit` / `run_shell` / `dispatch_agent` / 所有 MCP 工具——被拦时返回一条提示,告诉模型"先用只读工具调研,再调 `exit_plan_mode` 提交计划"。
- system prompt 注入计划模式须知,模型据此主动先调研、出计划。

模型调研完毕后调用 **`exit_plan_mode`** 工具并附完整计划:

```
  ✦ Proposed plan
  │ 1. 在 src/auth.ts 加 refreshToken()
  │ 2. 为其补单测 src/auth.test.ts
  │ 3. 跑 npm test 验证

  Proceed with this plan?
  ❯ Approve & execute
    Keep planning (revise)
```

- **Approve & execute** → 关闭计划模式、解锁全工具,模型开始实现。
- **Keep planning** → 留在计划模式,模型据反馈修订计划后再次提交。

**需要可交互的终端(TTY)才能批准**。无 TTY(管道/CI)时根本无法进入计划模式——`--plan` 会告警并忽略、`/plan` 拒绝开启,避免"进了却无法批准、模型空转烧预算"的死锁。注意批准只依赖 TTY、与 `--yolo` 无关:`--plan --yolo` 在真终端仍可用(yolo 只放开执行期的 shell 确认)。

## 实现与边界

- `src/agent/plan.ts` —— `planModeGate(active, name)` 纯拦截决策(只读允许集 `PLAN_MODE_READONLY`)、`makeExitPlanModeTool(deps)`(`active`/`propose`/`onApproved` 由 cli 注入)。**模型无关**:只 import `Tool`。
- `src/cli.ts` —— `planState` 单一真源;`makeGate` 中**计划闸优先于 hooks 闸**;切模型/档位经 `refreshSystem()` 据当前 plan 状态重算 system;提示符用动态函数显示 `floom(plan)>`。
- `/plan` 经 `SlashContext.isPlanMode/setPlanMode` 切换。

### 已知边界

- `exit_plan_mode` 工具始终注册,但非计划模式下调用是 no-op(返回"not in plan mode");system prompt 仅在计划模式提及它。
- 计划模式拦截基于工具名**白名单**(只读集),未知工具(含 MCP)一律按"可能有副作用"拦截——保守、安全。
- 计划文本不持久化;计划模式状态是会话内瞬时状态,不写入 `.floom/sessions`。
